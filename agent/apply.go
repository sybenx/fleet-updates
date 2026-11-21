package main

// Local rules and installs. The machine applies only its own list; the dashboard's approval can
// narrow it (`only`), never add to it.
//
// Overnight (02:00-05:00 local), no approval needed:
//   formulae: yes, unless pinned
//   casks: not .pkg, app not running, this version first seen here 2 days ago or more
//   flatpak: everything
//   winget: everything not on the ask-first list, not needing explicit targeting
//   Dockge stacks, system updates: never
// Approved (a click): the machine's own list as approved, still never .pkg casks without a person,
// never a running app, never brew's greedy mode, nothing while a game runs.

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const caskAge = 48 * time.Hour

func (e *Env) overnightOK(st *State, it Item) bool {
	switch it.Channel {
	case "brew-formula":
		return !it.Flags.Pinned
	case "brew-cask":
		if it.Flags.Pkg {
			return false
		}
		seen, ok := st.CaskSeen[it.Name+"@"+it.Latest]
		return ok && e.Now().Unix()-seen >= int64(caskAge.Seconds())
	case "flatpak-user", "flatpak-system":
		return true
	case "winget":
		return !it.Flags.Explicit && !matchesAskFirst(it.Name, st.AskFirst)
	}
	return false
}

func clickOK(it Item, overrides map[string]string) bool {
	switch it.Channel {
	case "brew-formula":
		return !it.Flags.Pinned
	case "brew-cask", "flatpak-user", "flatpak-system", "winget":
		return true
	case "dockge":
		pinned := it.Flags.PinnedRef
		switch overrides[it.Name] {
		case "pinned":
			pinned = true
		case "compare":
			pinned = false
		}
		return it.Flags.Update && !it.Flags.Local && !it.Flags.NotRunning && !pinned
	}
	return false
}

// Note the first time each cask version is seen here, for the 2 day rule.
func (e *Env) noteCasks(st *State, items []Item) {
	now := e.Now().Unix()
	keep := map[string]int64{}
	for _, it := range items {
		if it.Channel != "brew-cask" {
			continue
		}
		k := it.Name + "@" + it.Latest
		if v, ok := st.CaskSeen[k]; ok {
			keep[k] = v
		} else {
			keep[k] = now
		}
	}
	st.CaskSeen = keep
}

func (e *Env) appRunning(app string) bool {
	var ps string
	if e.Fixtures != "" {
		b, _ := os.ReadFile(filepath.Join(e.Fixtures, "running"))
		ps = string(b)
	} else {
		ps, _ = cmd(time.Minute, false, "ps", "-axo", "comm=")
	}
	return strings.Contains(ps, "/"+app+"/Contents/")
}

var reJavaClient = regexp.MustCompile(`net\.minecraft\.client|--accessToken`)

// gameRunning: a Steam game (anything under steamapps/common), a Minecraft client, or a name from
// FLEET_GAMES or games.txt in the state folder.
func (e *Env) gameRunning() bool {
	names := map[string]bool{"Minecraft.Windows": true, "MinecraftLauncher": true}
	for _, n := range strings.Fields(os.Getenv("FLEET_GAMES")) {
		names[n] = true
	}
	if b, err := os.ReadFile(filepath.Join(e.StateDir, "games.txt")); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			l = strings.TrimSuffix(strings.TrimSpace(l), ".exe")
			if l != "" && !strings.HasPrefix(l, "#") {
				names[l] = true
			}
		}
	}
	for _, p := range e.processes() {
		if names[p.name] {
			return true
		}
		path := strings.ReplaceAll(p.path+" "+p.cmdline, `\`, "/")
		if strings.Contains(strings.ToLower(path), "steamapps/common/") {
			return true
		}
		if (p.name == "java" || p.name == "javaw") && reJavaClient.MatchString(p.cmdline) {
			return true
		}
	}
	return false
}

type proc struct{ name, path, cmdline string }

func (e *Env) processes() []proc {
	var text string
	if e.Fixtures != "" {
		for _, f := range []string{"processes", "processes.txt"} {
			if b, err := os.ReadFile(filepath.Join(e.Fixtures, f)); err == nil {
				text = string(b)
				break
			}
		}
	} else {
		text = listProcesses()
	}
	var out []proc
	for _, l := range strings.Split(text, "\n") {
		l = strings.TrimRight(l, "\r")
		if strings.TrimSpace(l) == "" {
			continue
		}
		c := strings.Split(l, "\t")
		if len(c) >= 3 {
			out = append(out, proc{name: strings.TrimSuffix(c[0], ".exe"), path: c[1], cmdline: c[2]})
			continue
		}
		// Unix: one command line per line.
		first := strings.Fields(l)[0]
		out = append(out, proc{name: filepath.Base(first), path: first, cmdline: l})
	}
	return out
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " ")
}

// Install one item. -> status, message
func (e *Env) install(it Item) (string, string) {
	run := func(name string, args ...string) (string, string) {
		line := name + " " + strings.Join(args, " ")
		if e.Dry {
			e.say("would run: %s", line)
			return "dry-run", line
		}
		out, code := cmd(time.Hour, true, name, args...)
		if code == 0 {
			return "installed", ""
		}
		// winget: 0x8A150109, installed and a reboot finishes it.
		if name == "winget" && (code == -1978335991 || code == 0x8A150109) {
			return "installed", "reboot after"
		}
		if regexp.MustCompile(`(?i)sudo|password|not allowed|authoriz|polkit`).MatchString(out) {
			return "needs-password", lastLines(out, 3)
		}
		return "failed", lastLines(out, 3)
	}
	switch it.Channel {
	case "brew-formula":
		return run("brew", "upgrade", "--formula", it.Name)
	case "brew-cask":
		if it.Flags.Pkg {
			e.say("skip %s: needs your password (.pkg)", it.Name)
			return "needs-password", "pkg installer"
		}
		for _, app := range it.Flags.Apps {
			if e.appRunning(app) {
				e.say("skip %s: %s is running", it.Name, app)
				return "quit-first", app + " is running"
			}
		}
		return run("brew", "upgrade", "--cask", it.Name)
	case "flatpak-user", "flatpak-system":
		if e.gameRunning() {
			e.say("skip %s: a game is running", it.Name)
			return "game-running", ""
		}
		scope := "--" + strings.TrimPrefix(it.Channel, "flatpak-")
		if e.Dry {
			return run("flatpak", "update", scope, "-y", "--noninteractive", it.Name)
		}
		return run("nice", "-n", "10", "flatpak", "update", scope, "-y", "--noninteractive", it.Name)
	case "winget":
		if e.gameRunning() {
			e.say("skip %s: a game is running", it.Name)
			return "game-running", ""
		}
		st, msg := run("winget", "upgrade", "--id", it.Name, "--exact", "--silent", "--accept-source-agreements", "--accept-package-agreements", "--disable-interactivity")
		return st, msg
	case "dockge":
		dir := filepath.Join(e.StacksDir, it.Name)
		if !reStackName.MatchString(it.Name) {
			return "failed", "bad stack name"
		}
		if _, err := os.Stat(dir); err != nil {
			return "failed", "no such stack"
		}
		if e.Dry {
			e.say("would run in %s: docker compose pull && docker compose up -d", dir)
			return "dry-run", "docker compose pull + up -d"
		}
		for _, args := range [][]string{{"compose", "pull", "--quiet"}, {"compose", "up", "-d"}} {
			c := execIn(dir, "docker", args...)
			if out, code := c(); code != 0 {
				return "failed", lastLines(out, 3)
			}
		}
		return "installed", ""
	}
	return "failed", "not handled here: " + it.Channel
}
