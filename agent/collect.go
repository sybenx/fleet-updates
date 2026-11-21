package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Env is how one run sees the world: real commands, or fixture files standing in for them.
type Env struct {
	OS        string
	Dry       bool
	Fixtures  string // FLEET_FIXTURE_DIR
	StateDir  string
	StacksDir string
	Now       func() time.Time
	Hour      int // -1: the real hour
	Out       *os.File
	Log       func(string)
}

func (e *Env) say(format string, a ...any) {
	msg := fmt.Sprintf(format, a...)
	if e.Log != nil {
		e.Log(msg)
	}
	if e.Dry && e.Out != nil {
		fmt.Fprintln(e.Out, msg)
	}
}

func (e *Env) hour() int {
	if e.Hour >= 0 {
		return e.Hour
	}
	return e.Now().Hour()
}

func (e *Env) InWindow() bool { h := e.hour(); return h >= 2 && h < 5 }

// cmd runs a command with no stdin and returns its output (stdout, plus stderr when asked).
func cmd(timeout time.Duration, withStderr bool, name string, args ...string) (string, int) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	c := exec.CommandContext(ctx, name, args...)
	c.Stdin = nil
	var out bytes.Buffer
	c.Stdout = &out
	if withStderr {
		c.Stderr = &out
	}
	err := c.Run()
	code := 0
	if err != nil {
		code = -1
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		}
	}
	return out.String(), code
}

// tool: the fixture file if there are fixtures, else the command's output.
func (e *Env) tool(fixture string, name string, args ...string) string {
	if e.Fixtures != "" {
		b, _ := os.ReadFile(filepath.Join(e.Fixtures, fixture))
		return string(b)
	}
	if _, err := exec.LookPath(name); err != nil {
		return ""
	}
	out, _ := cmd(10*time.Minute, false, name, args...)
	return out
}

func (e *Env) has(name string) bool {
	if e.Fixtures != "" {
		return true
	}
	_, err := exec.LookPath(name)
	return err == nil
}

func (e *Env) fixtureExists(name string) bool {
	if e.Fixtures == "" {
		return true
	}
	_, err := os.Stat(filepath.Join(e.Fixtures, name))
	return err == nil
}

func hostname() string {
	h, _ := os.Hostname()
	if i := strings.Index(h, "."); i > 0 {
		h = h[:i]
	}
	return h
}

// Collect asks every channel on this machine what is out of date.
func (e *Env) Collect(st *State) ([]Item, []Badge) {
	switch e.OS {
	case "mac":
		if e.Fixtures == "" && !e.Dry {
			cmd(10*time.Minute, false, "brew", "update", "--quiet")
		}
		items := MacItems(
			e.tool("brew-outdated.json", "brew", "outdated", "--json=v2"),
			e.tool("brew-casks.json", "brew", "info", "--cask", "--json=v2", "--installed"),
			e.tool("running", "ps", "-axo", "comm="),
		)
		return items, ParseSoftwareUpdate(e.tool("softwareupdate.txt", "softwareupdate", "-l"))
	case "linux":
		items := []Item{}
		if e.has("flatpak") {
			for _, scope := range []string{"user", "system"} {
				items = append(items, ParseFlatpak(
					e.tool("flatpak-"+scope+"-updates.txt", "flatpak", "remote-ls", "--updates", "--"+scope, "--columns=application,branch,version"),
					e.tool("flatpak-"+scope+"-list.txt", "flatpak", "list", "--"+scope, "--columns=application,branch,version"),
					scope)...)
			}
		}
		badges := []Badge{}
		if e.has("rpm-ostree") && e.fixtureExists("rpm-ostree.json") {
			badges = ParseRpmOstree(e.tool("rpm-ostree.json", "rpm-ostree", "status", "--json"))
		}
		return items, badges
	case "windows":
		items := ParseWinget(e.tool("winget.txt", "winget", "upgrade", "--accept-source-agreements", "--disable-interactivity"))
		wu := e.tool("windows-update.txt", "powershell", "-NoProfile", "-NonInteractive", "-Command",
			`try { $s=(New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher(); ($s.Search("IsInstalled=0 and IsHidden=0 and Type='Software'").Updates | ForEach-Object { $_.Title }) -join "`+"`n"+`" } catch { '' }`)
		rp := e.tool("reboot-pending.txt", "powershell", "-NoProfile", "-NonInteractive", "-Command",
			`if ((Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') -or (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')) { '1' } else { '0' }`)
		return items, ParseWindowsUpdate(wu, rp)
	case "dockge":
		services, registry := e.dockgeLines(st)
		return ParseDockge(services, registry), []Badge{}
	}
	return []Item{}, []Badge{}
}

var reStackName = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

func (e *Env) stacks() []string {
	entries, _ := os.ReadDir(e.StacksDir)
	var out []string
	for _, d := range entries {
		if !d.IsDir() || !reStackName.MatchString(d.Name()) {
			continue
		}
		for _, f := range []string{"compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"} {
			if _, err := os.Stat(filepath.Join(e.StacksDir, d.Name(), f)); err == nil {
				out = append(out, d.Name())
				break
			}
		}
	}
	sort.Strings(out)
	return out
}

// dockgeLines lists each stack's containers and asks the registry for each tag's digest (a
// manifest lookup, nothing is pulled), reusing a digest for 6 hours.
func (e *Env) dockgeLines(st *State) (string, string) {
	var sb strings.Builder
	refs := map[string]bool{}
	for _, s := range e.stacks() {
		ids, _ := cmd(time.Minute, false, "docker", "ps", "-aq", "--filter", "label=com.docker.compose.project="+s)
		fields := strings.Fields(ids)
		if len(fields) == 0 {
			fmt.Fprintf(&sb, "%s\t-\n", s)
			continue
		}
		for _, id := range fields {
			out, _ := cmd(time.Minute, false, "docker", "inspect", "--format", `{{index .Config.Labels "com.docker.compose.service"}}{{"\t"}}{{.Config.Image}}{{"\t"}}{{.Image}}{{"\t"}}{{.State.Status}}`, id)
			c := strings.Split(strings.TrimSpace(out), "\t")
			if len(c) < 4 {
				continue
			}
			rd, _ := cmd(time.Minute, false, "docker", "image", "inspect", "--format", `{{join .RepoDigests ","}}`, c[2])
			rd = strings.TrimSpace(rd)
			if rd == "" {
				rd = "-"
			} else if !strings.Contains(c[1], "@") {
				refs[c[1]] = true
			}
			fmt.Fprintf(&sb, "%s\t%s\t%s\t%s\t%s\t%s\n", s, c[0], c[1], c[2], c[3], rd)
		}
	}
	var rb strings.Builder
	now := e.Now().Unix()
	keys := make([]string, 0, len(refs))
	for r := range refs {
		keys = append(keys, r)
	}
	sort.Strings(keys)
	for _, ref := range keys {
		if c, ok := st.Registry[ref]; ok && now-c.At < 6*3600 {
			fmt.Fprintf(&rb, "%s\t%s\n", ref, c.Digest)
			continue
		}
		out, _ := cmd(2*time.Minute, true, "docker", "buildx", "imagetools", "inspect", ref)
		d := ""
		for _, l := range strings.Split(out, "\n") {
			if strings.HasPrefix(l, "Digest:") {
				d = digestOf(l)
				break
			}
		}
		if d != "" {
			st.Registry[ref] = RegDigest{Digest: d, At: now}
			fmt.Fprintf(&rb, "%s\t%s\n", ref, d)
		} else {
			lines := strings.Split(strings.TrimSpace(out), "\n")
			fmt.Fprintf(&rb, "%s\terror\t%s\n", ref, strings.ReplaceAll(lines[len(lines)-1], "\t", " "))
		}
	}
	return sb.String(), rb.String()
}
