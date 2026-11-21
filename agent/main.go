// fleet-agent: one program for the Mac, Linux (SteamOS, bazzite), Windows and Dockge hosts.
//
//	fleet-agent join [--url URL] [--approver HEX] [--os OS] TOKEN   make this machine's key and register it
//	fleet-agent run [--dry-run] [--full]                             one run (the OS timer calls this)
//	fleet-agent dockge [--once] [--dry-run]                          the Dockge agent, as a container
//	fleet-agent uninstall                                            take the card off the page, forget the key
//	fleet-agent parse KIND FILE...                                   print what a parser makes of tool output
//
// Each run: regenerate this machine's own list of updates, check the dashboard's approval against
// it (signer, counter, expiry, report hash), apply the approved part of its own list, apply the
// overnight part when it is 02:00-05:00, then send a fresh signed report.
//
// Env: FLEET_DRY_RUN=1, FLEET_FIXTURE_DIR, FLEET_HOUR, FLEET_NOW (unix), FLEET_FULL=1,
// FLEET_STATE_DIR, FLEET_OS, FLEET_STACKS_DIR, FLEET_GAMES, FLEET_URL, FLEET_APPROVER, FLEET_JOIN.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

var version = "0.1.1"

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "join":
		err = cmdJoin(os.Args[2:])
	case "run":
		err = cmdRun(os.Args[2:], "")
	case "dockge":
		err = cmdDockge(os.Args[2:])
	case "uninstall":
		err = cmdUninstall(os.Args[2:])
	case "parse":
		err = cmdParse(os.Args[2:])
	case "version":
		fmt.Println(version)
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "fleet-agent:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: fleet-agent join|run|dockge|uninstall|parse|version")
	os.Exit(2)
}

func hostOS() string {
	if o := os.Getenv("FLEET_OS"); o != "" {
		return o
	}
	switch runtime.GOOS {
	case "darwin":
		return "mac"
	case "windows":
		return "windows"
	}
	return "linux"
}

func envNow() func() time.Time {
	if v := os.Getenv("FLEET_NOW"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return func() time.Time { return time.Unix(n, 0) }
		}
	}
	return time.Now
}

// ---- http ----

var client = &http.Client{Timeout: 2 * time.Minute}

func postJSON(u string, body any, out any) error {
	b, _ := json.Marshal(body)
	res, err := client.Post(u, "application/json", bytes.NewReader(b))
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if res.StatusCode != 200 {
		var e struct{ Error string }
		json.Unmarshal(data, &e)
		return fmt.Errorf("%s: %d %s", u, res.StatusCode, e.Error)
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

func getApproval(st *State) (*Event, error) {
	res, err := client.Get(st.URL + "/api/agent/approval?m=" + url.QueryEscape(st.MachineID))
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var out struct {
		Approval *Event `json:"approval"`
	}
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("approval: %d", res.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&out); err != nil {
		return nil, err
	}
	return out.Approval, nil
}

// ---- join ----

var reHex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)

func join(dir, osName, serverURL, approver, token string) error {
	serverURL = strings.TrimRight(serverURL, "/")
	if !regexp.MustCompile(`^https?://[^\s'"]+$`).MatchString(serverURL) {
		return errors.New("bad server url")
	}
	if approver != "" && !reHex64.MatchString(approver) {
		return errors.New("bad approver key")
	}
	sk, err := NewSecretKey()
	if err != nil {
		return err
	}
	pk, _ := PublicKey(sk)
	var reply struct {
		Machine  string `json:"machine"`
		Approver string `json:"approver"`
	}
	if err := postJSON(serverURL+"/api/agent/register", map[string]string{"join": token, "os": osName, "host": hostname(), "pubkey": pk}, &reply); err != nil {
		return fmt.Errorf("could not register (the command works once and for an hour; make a new one on the page): %w", err)
	}
	// The approver comes from the join command. Without one, the dashboard's answer is used.
	if approver == "" {
		approver = reply.Approver
	} else if reply.Approver != approver {
		return errors.New("the dashboard's approver key is not the one in the join command")
	}
	st := &State{URL: serverURL, MachineID: reply.Machine, Approver: approver, SecretKey: sk, OS: osName,
		AskFirst: append([]string{}, DefaultAskFirst...), CaskSeen: map[string]int64{}, Registry: map[string]RegDigest{}}
	if err := saveState(dir, st); err != nil {
		return err
	}
	fmt.Printf("joined as machine %s\n", reply.Machine)
	return nil
}

func cmdJoin(args []string) error {
	fs := flag.NewFlagSet("join", flag.ExitOnError)
	u := fs.String("url", os.Getenv("FLEET_URL"), "dashboard address")
	a := fs.String("approver", os.Getenv("FLEET_APPROVER"), "approver public key (hex)")
	o := fs.String("os", hostOS(), "mac, linux, windows or dockge")
	fs.Parse(args)
	if fs.NArg() != 1 {
		return errors.New("usage: fleet-agent join [--url URL] [--approver HEX] TOKEN")
	}
	return join(defaultStateDir(*o), *o, *u, *a, fs.Arg(0))
}

// ---- run ----

type runOpts struct {
	dry, full bool
}

func newEnv(osName, dir string, dry bool) *Env {
	hour := -1
	if h := os.Getenv("FLEET_HOUR"); h != "" {
		hour, _ = strconv.Atoi(h)
	}
	stacks := os.Getenv("FLEET_STACKS_DIR")
	if stacks == "" {
		stacks = "/opt/stacks"
	}
	logPath := filepath.Join(dir, "fleet-agent.log")
	e := &Env{OS: osName, Dry: dry, Fixtures: os.Getenv("FLEET_FIXTURE_DIR"), StateDir: dir, StacksDir: stacks, Now: envNow(), Hour: hour, Out: os.Stdout}
	e.Log = func(msg string) {
		f, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err == nil {
			fmt.Fprintf(f, "%s %s\n", e.Now().Format("2006-01-02 15:04:05"), msg)
			f.Close()
		}
	}
	return e
}

func cmdRun(args []string, forceOS string) error {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	dry := fs.Bool("dry-run", os.Getenv("FLEET_DRY_RUN") == "1", "print what would be installed, install nothing")
	full := fs.Bool("full", os.Getenv("FLEET_FULL") == "1", "check every channel now")
	fs.Parse(args)
	osName := forceOS
	if osName == "" {
		osName = hostOS()
	}
	dir := defaultStateDir(osName)
	return runOnce(dir, osName, runOpts{dry: *dry, full: *full})
}

func runOnce(dir, osName string, o runOpts) error {
	lowerPriority()
	if strings.HasPrefix(strings.ToLower(filepath.Clean(dir)), `c:\mc`) {
		return errors.New("refusing to run from C:\\mc")
	}
	st, err := loadState(dir)
	if err != nil {
		return fmt.Errorf("not joined yet (%v)", err)
	}
	unlock, err := lock(dir)
	if err != nil {
		return nil
	}
	defer unlock()
	// Work from the state folder, never from wherever the timer started us.
	os.Chdir(dir)
	e := newEnv(osName, dir, o.dry)
	now := e.Now().Unix()

	every := int64(7200)
	if e.InWindow() {
		every = 1800
	}
	fresh := false
	if o.full || st.Items == nil || now-st.CheckedAt >= every {
		st.Items, st.Badges = e.Collect(st)
		st.CheckedAt = now
		fresh = true
	}
	e.noteCasks(st, st.Items)

	applied := map[string]bool{}
	record := func(how string, it Item, status, msg string) {
		applied[it.Channel+"\x00"+it.Name] = true
		e.Log(fmt.Sprintf("%s %s %s %s %s", how, it.Channel, it.Name, status, msg))
		if status == "game-running" {
			return
		}
		st.Applied = append(st.Applied, Applied{At: e.Now().UTC().Format(time.RFC3339), How: how, Channel: it.Channel, Name: it.Name, Title: it.Title, From: it.Current, To: it.Latest, Status: status, Message: msg})
		if len(st.Applied) > 50 {
			st.Applied = st.Applied[len(st.Applied)-50:]
		}
	}
	installed := false

	// 1. The approval, if there is one for exactly this list.
	ev, err := getApproval(st)
	if err != nil {
		e.say("approval fetch failed: %v", err)
	}
	if ev != nil {
		if p, ok := PolicyFrom(ev, st.Approver, st.MachineID, st.PolicyCounter, now); ok {
			if len(p.AskFirst) > 0 {
				st.AskFirst = p.AskFirst
			}
			st.PolicyCounter = p.Counter
		}
		a := CheckApproval(ev, st.Approver, st.MachineID, st.LastCounter, ReportHash(osName, st.Items), now)
		if a.OK && !fresh {
			// Regenerate the list before acting on it; the approval must match what is true now.
			st.Items, st.Badges = e.Collect(st)
			st.CheckedAt = now
			fresh = true
			a = CheckApproval(ev, st.Approver, st.MachineID, st.LastCounter, ReportHash(osName, st.Items), now)
		}
		if !a.OK {
			if a.Reason != "old counter" {
				e.say("approval not used: %s", a.Reason)
			}
		} else {
			e.say("approval %d: applying", a.Counter)
			for _, it := range st.Items {
				if len(a.Only) > 0 && !contains(a.Only, ItemID(it.Channel, it.Name)) {
					continue
				}
				if !clickOK(it, a.Overrides) {
					continue
				}
				status, msg := e.install(it)
				record("click", it, status, msg)
				installed = installed || status == "installed"
			}
			st.LastCounter = a.Counter
		}
	}

	// 2. Overnight, by this machine's own rules.
	if e.InWindow() {
		for _, it := range st.Items {
			if applied[it.Channel+"\x00"+it.Name] || !e.overnightOK(st, it) {
				continue
			}
			if it.Channel == "brew-cask" {
				running := false
				for _, app := range it.Flags.Apps {
					running = running || e.appRunning(app)
				}
				if running {
					continue
				}
			}
			status, msg := e.install(it)
			record("overnight", it, status, msg)
			installed = installed || status == "installed"
		}
	} else if o.dry && osName != "dockge" {
		e.say("outside 02:00-05:00: no overnight installs")
	}

	// 3. A fresh report: what is left, and what was applied.
	if installed {
		st.Items, st.Badges = e.Collect(st)
		st.CheckedAt = now
	}
	rep, err := ReportEvent(st.MachineID, ReportContent{OS: osName, Host: hostname(), Items: st.Items, Badges: st.Badges, Applied: st.Applied, LastCounter: st.LastCounter}, e.Now().Unix(), st.SecretKey)
	if err != nil {
		return err
	}
	if err := postJSON(st.URL+"/api/agent/report", rep, nil); err != nil {
		e.say("report failed: %v", err)
	}
	return saveState(dir, st)
}

// ---- dockge ----

func cmdDockge(args []string) error {
	fs := flag.NewFlagSet("dockge", flag.ExitOnError)
	once := fs.Bool("once", false, "one run, then exit")
	dry := fs.Bool("dry-run", os.Getenv("FLEET_DRY_RUN") == "1", "print what would run, run nothing")
	fs.Parse(args)
	dir := defaultStateDir("dockge")
	if _, err := loadState(dir); err != nil {
		if err := join(dir, "dockge", os.Getenv("FLEET_URL"), os.Getenv("FLEET_APPROVER"), os.Getenv("FLEET_JOIN")); err != nil {
			return err
		}
	}
	poll := 60 * time.Second
	if v, err := strconv.Atoi(os.Getenv("FLEET_POLL")); err == nil && v > 0 {
		poll = time.Duration(v) * time.Second
	}
	for {
		if err := runOnce(dir, "dockge", runOpts{dry: *dry}); err != nil {
			fmt.Fprintln(os.Stderr, "fleet-agent:", err)
		}
		if *once {
			return nil
		}
		time.Sleep(poll)
	}
}

func execIn(dir, name string, args ...string) func() (string, int) {
	return func() (string, int) {
		c := exec.Command(name, args...)
		c.Dir = dir
		var out bytes.Buffer
		c.Stdout, c.Stderr = &out, &out
		err := c.Run()
		if err != nil {
			if ee, ok := err.(*exec.ExitError); ok {
				return out.String(), ee.ExitCode()
			}
			return out.String() + err.Error(), -1
		}
		return out.String(), 0
	}
}

// ---- uninstall ----

func cmdUninstall(args []string) error {
	osName := hostOS()
	if len(args) > 0 && args[0] == "--dockge" {
		osName = "dockge"
	}
	dir := defaultStateDir(osName)
	st, err := loadState(dir)
	if err != nil {
		return nil
	}
	ev, err := ReportEvent(st.MachineID, ReportContent{OS: osName, Uninstall: true}, time.Now().Unix(), st.SecretKey)
	if err == nil {
		if err := postJSON(st.URL+"/api/agent/report", ev, nil); err != nil {
			fmt.Fprintln(os.Stderr, "Could not reach the dashboard: remove the card on the page.")
		}
	}
	os.Remove(filepath.Join(dir, "state.json"))
	return nil
}

// ---- parse (for the cross-checks with server/parse.js) ----

func cmdParse(args []string) error {
	if len(args) < 1 {
		return errors.New("usage: fleet-agent parse KIND FILE...")
	}
	read := func(i int) string {
		if i+1 >= len(args) {
			return ""
		}
		b, _ := os.ReadFile(args[i+1])
		return string(b)
	}
	var out any
	switch args[0] {
	case "mac":
		out = MacItems(read(0), read(1), read(2))
	case "softwareupdate":
		out = ParseSoftwareUpdate(read(0))
	case "winget":
		out = ParseWinget(read(0))
	case "windows-update":
		out = ParseWindowsUpdate(read(0), read(1))
	case "flatpak-user", "flatpak-system":
		out = ParseFlatpak(read(0), read(1), strings.TrimPrefix(args[0], "flatpak-"))
	case "rpm-ostree":
		out = ParseRpmOstree(read(0))
	case "dockge":
		out = ParseDockge(read(0), read(1))
	default:
		return errors.New("unknown kind")
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	return enc.Encode(out)
}
