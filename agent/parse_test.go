package main

import (
	"os"
	"strings"
	"testing"
	"time"
)

const fx = "../test/fixtures/"

func read(t *testing.T, p string) string {
	b, err := os.ReadFile(fx + p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func byName(items []Item) map[string]Item {
	m := map[string]Item{}
	for _, i := range items {
		m[i.Name] = i
	}
	return m
}

func TestMac(t *testing.T) {
	items := MacItems(read(t, "mac/brew-outdated.json"), read(t, "mac/brew-casks.json"), read(t, "mac/running"))
	if len(items) != 6 {
		t.Fatalf("%d items", len(items))
	}
	m := byName(items)
	if m["jq"].Current != "1.7" || m["jq"].Latest != "1.7.1" || m["jq"].Channel != "brew-formula" {
		t.Fatal("jq")
	}
	if !m["node@20"].Flags.Pinned || !m["zoom"].Flags.Pkg || !m["discord"].Flags.Running || m["firefox"].Flags.Running {
		t.Fatal("flags")
	}
	if m["firefox"].Title != "Mozilla Firefox" || m["newapp"].Flags.Apps[0] != "New App.app" {
		t.Fatal("cask info")
	}
	b := ParseSoftwareUpdate(read(t, "mac/softwareupdate.txt"))
	if len(b) != 2 || b[0].Title != "macOS Tahoe 26.2" || !b[0].Restart || b[1].Restart {
		t.Fatalf("softwareupdate %+v", b)
	}
	if len(ParseBrewOutdated("not json")) != 0 {
		t.Fatal("bad json")
	}
}

func TestWinget(t *testing.T) {
	for _, text := range []string{read(t, "windows/winget.txt"), strings.ReplaceAll(read(t, "windows/winget.txt"), "\n", "\r\n")} {
		items := ParseWinget(text)
		var ids []string
		for _, i := range items {
			ids = append(ids, i.Name)
		}
		if strings.Join(ids, " ") != "Discord.Discord Microsoft.EdgeWebView2Runtime EclipseAdoptium.Temurin.21.JDK 7zip.7zip Valve.Steam Spotify.Spotify" {
			t.Fatalf("ids %v", ids)
		}
		if items[2].Title != "Eclipse Temurin JDK with Hotspot 21.0" || items[3].Current != "< 23.01" || !items[5].Flags.Explicit || items[0].Flags.Explicit {
			t.Fatalf("fields %+v", items)
		}
	}
	b := ParseWindowsUpdate(read(t, "windows/windows-update.txt"), "1")
	if b[0].Count != 2 || !b[1].Reboot {
		t.Fatal("windows update")
	}
}

func TestLinux(t *testing.T) {
	u := ParseFlatpak(read(t, "linux/flatpak-user-updates.txt"), read(t, "linux/flatpak-user-list.txt"), "user")
	if u[0].Name != "org.mozilla.firefox//stable" || u[0].Current != "120.0" || u[0].Latest != "121.0" || u[0].Channel != "flatpak-user" {
		t.Fatalf("%+v", u[0])
	}
	if len(ParseFlatpak("Application ID\tBranch\tVersion\norg.a.B\tstable\t2\n", "", "user")) != 1 {
		t.Fatal("header")
	}
	b := ParseRpmOstree(read(t, "linux/rpm-ostree.json"))
	if len(b) != 1 || !b[0].Staged {
		t.Fatalf("rpm-ostree %+v", b)
	}
}

func TestPins(t *testing.T) {
	for _, r := range []string{"ditto:2.5", "x/y:0.12.12", "z:2026.7.2", "tailscale/tailscale:v1.104.1", "a:7.2-alpine", "ghcr.io/s/c:sha-fc4319c", "r@sha256:" + strings.Repeat("a", 64)} {
		if !IsPinnedRef(r) {
			t.Errorf("%s should be pinned", r)
		}
	}
	for _, r := range []string{"redis", "redis:latest", "python:3", "postgres:17", "node:2-alpine", "debian:12-slim", "localhost:5000/app", "x:deadbeef"} {
		if IsPinnedRef(r) {
			t.Errorf("%s should not be pinned", r)
		}
	}
	if MajorOf("postgres:17") != "17" || MajorOf("node:2-alpine") != "" || MajorOf("x:2.5") != "" {
		t.Fatal("majors")
	}
}

func TestRules(t *testing.T) {
	now := time.Unix(1795000000, 0)
	e := &Env{OS: "mac", Now: func() time.Time { return now }, Hour: 3}
	st := &State{CaskSeen: map[string]int64{"firefox@121.0": now.Unix() - 49*3600, "newapp@2.0": now.Unix() - 3600}, AskFirst: DefaultAskFirst}
	ok := func(it Item) bool { return e.overnightOK(st, it) }
	if !ok(Item{Channel: "brew-cask", Name: "firefox", Latest: "121.0"}) || ok(Item{Channel: "brew-cask", Name: "newapp", Latest: "2.0"}) {
		t.Fatal("cask age")
	}
	if ok(Item{Channel: "brew-cask", Name: "firefox", Latest: "121.0", Flags: Flags{Pkg: true}}) {
		t.Fatal("pkg overnight")
	}
	if ok(Item{Channel: "winget", Name: "EclipseAdoptium.Temurin.21.JDK"}) || !ok(Item{Channel: "winget", Name: "Discord.Discord"}) || ok(Item{Channel: "winget", Name: "Spotify.Spotify", Flags: Flags{Explicit: true}}) {
		t.Fatal("winget")
	}
	if ok(Item{Channel: "dockge", Name: "dozzle", Flags: Flags{Update: true}}) {
		t.Fatal("stacks never overnight")
	}
	if clickOK(Item{Channel: "dockge", Name: "c", Flags: Flags{Update: true, PinnedRef: true}}, nil) || !clickOK(Item{Channel: "dockge", Name: "c", Flags: Flags{Update: true, PinnedRef: true}}, map[string]string{"c": "compare"}) {
		t.Fatal("pins and overrides")
	}
	if clickOK(Item{Channel: "dockge", Name: "t", Flags: Flags{Update: true, Local: true}}, map[string]string{"t": "compare"}) {
		t.Fatal("local builds never")
	}
}
