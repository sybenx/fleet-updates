package main

// Parsers for the package managers' output. The same rules as server/parse.js, which the node
// tests hold equal to these on the shared fixtures in test/fixtures.

import (
	"encoding/json"
	"regexp"
	"sort"
	"strings"
)

func decodeJSON(text string, v any) bool {
	if strings.TrimSpace(text) == "" {
		return false
	}
	if json.Unmarshal([]byte(text), v) == nil {
		return true
	}
	// brew can print warnings before the JSON.
	if i := strings.Index(text, "{"); i > 0 {
		return json.Unmarshal([]byte(text[i:]), v) == nil
	}
	return false
}

// ---- Mac ----

func ParseBrewOutdated(text string) []Item {
	var j struct {
		Formulae []struct {
			Name              string   `json:"name"`
			InstalledVersions []string `json:"installed_versions"`
			CurrentVersion    string   `json:"current_version"`
			Pinned            bool     `json:"pinned"`
		} `json:"formulae"`
		Casks []struct {
			Name              string   `json:"name"`
			InstalledVersions []string `json:"installed_versions"`
			CurrentVersion    string   `json:"current_version"`
		} `json:"casks"`
	}
	items := []Item{}
	if !decodeJSON(text, &j) {
		return items
	}
	last := func(v []string) string {
		if len(v) == 0 {
			return ""
		}
		return v[len(v)-1]
	}
	for _, f := range j.Formulae {
		items = append(items, Item{Channel: "brew-formula", Name: f.Name, Title: f.Name, Current: last(f.InstalledVersions), Latest: f.CurrentVersion, Flags: Flags{Pinned: f.Pinned}})
	}
	for _, c := range j.Casks {
		items = append(items, Item{Channel: "brew-cask", Name: c.Name, Title: c.Name, Current: last(c.InstalledVersions), Latest: c.CurrentVersion})
	}
	return items
}

type CaskInfo struct {
	Title string
	Pkg   bool
	Apps  []string
}

func ParseBrewCasks(text string) map[string]CaskInfo {
	var j struct {
		Casks []struct {
			Token     string            `json:"token"`
			Name      []string          `json:"name"`
			Artifacts []json.RawMessage `json:"artifacts"`
		} `json:"casks"`
	}
	out := map[string]CaskInfo{}
	if !decodeJSON(text, &j) {
		return out
	}
	for _, c := range j.Casks {
		info := CaskInfo{Title: c.Token}
		if len(c.Name) > 0 {
			info.Title = c.Name[0]
		}
		for _, raw := range c.Artifacts {
			var a map[string]json.RawMessage
			if json.Unmarshal(raw, &a) != nil {
				continue
			}
			if _, ok := a["pkg"]; ok {
				info.Pkg = true
			}
			if _, ok := a["installer"]; ok {
				info.Pkg = true
			}
			if appRaw, ok := a["app"]; ok {
				var apps []any
				if json.Unmarshal(appRaw, &apps) == nil {
					for _, x := range apps {
						if s, ok := x.(string); ok {
							parts := strings.Split(s, "/")
							info.Apps = append(info.Apps, parts[len(parts)-1])
						}
					}
				}
			}
		}
		out[c.Token] = info
	}
	return out
}

var reSoftwareUpdate = regexp.MustCompile(`^\s*Title:\s*(.+?),\s*Version:\s*([^,]+)(.*)$`)

func ParseSoftwareUpdate(text string) []Badge {
	out := []Badge{}
	for _, line := range strings.Split(text, "\n") {
		m := reSoftwareUpdate.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		out = append(out, Badge{Channel: "softwareupdate", Title: strings.TrimSpace(m[1]), Version: strings.TrimSpace(m[2]), Restart: regexp.MustCompile(`(?i)Action:\s*restart`).MatchString(m[3])})
	}
	return out
}

var reApp = regexp.MustCompile(`([^/]+\.app)/Contents/`)

func ParseRunningApps(text string) map[string]bool {
	out := map[string]bool{}
	for _, line := range strings.Split(text, "\n") {
		if m := reApp.FindStringSubmatch(line); m != nil {
			out[m[1]] = true
		}
	}
	return out
}

// MacItems joins brew outdated with cask info and the running apps.
func MacItems(outdated, casks, running string) []Item {
	info := ParseBrewCasks(casks)
	run := ParseRunningApps(running)
	items := ParseBrewOutdated(outdated)
	for i := range items {
		it := &items[i]
		if it.Channel != "brew-cask" {
			continue
		}
		if ci, ok := info[it.Name]; ok {
			it.Title = ci.Title
			it.Flags.Pkg = ci.Pkg
			it.Flags.Apps = ci.Apps
			for _, a := range ci.Apps {
				if run[a] {
					it.Flags.Running = true
				}
			}
		}
	}
	return items
}

// ---- Windows ----

var (
	reWingetHeader  = regexp.MustCompile(`^\s*Name\s+Id\s+Version\s+Available`)
	reWingetSource  = regexp.MustCompile(`\sSource\s*$`)
	reWingetDashes  = regexp.MustCompile(`^-{10,}$`)
	reWingetSummary = regexp.MustCompile(`(?i)^\d+ (upgrades?|packages?)`)
	reWingetID      = regexp.MustCompile(`^[\w.+-]+$`)
)

// ParseWinget reads the `winget upgrade` table from the right (Source, Available, Version, Id) so
// wide characters in names do not shift the columns.
func ParseWinget(text string) []Item {
	items := []Item{}
	explicit, inTable, hasSource := false, false, true
	for _, raw := range strings.Split(text, "\n") {
		raw = strings.TrimSuffix(raw, "\r")
		line := raw
		if i := strings.LastIndex(raw, "\r"); i >= 0 {
			line = raw[i+1:]
		}
		if strings.Contains(strings.ToLower(line), "require explicit targeting") {
			explicit, inTable = true, false
			continue
		}
		if reWingetHeader.MatchString(line) {
			hasSource = reWingetSource.MatchString(line)
			continue
		}
		if reWingetDashes.MatchString(strings.TrimSpace(line)) {
			inTable = true
			continue
		}
		if !inTable {
			continue
		}
		t := strings.TrimSpace(line)
		if t == "" || reWingetSummary.MatchString(t) || strings.Contains(strings.ToLower(line), "cannot be determined") {
			inTable = false
			continue
		}
		tok := strings.Fields(t)
		need := 4
		if hasSource {
			need = 5
		}
		if len(tok) < need {
			continue
		}
		pop := func() string { v := tok[len(tok)-1]; tok = tok[:len(tok)-1]; return v }
		source := ""
		if hasSource {
			source = pop()
		}
		latest := pop()
		current := pop()
		if len(tok) > 0 && (tok[len(tok)-1] == "<" || tok[len(tok)-1] == ">") {
			current = pop() + " " + current
		}
		if len(tok) == 0 {
			continue
		}
		id := pop()
		title := strings.TrimSpace(strings.TrimSuffix(strings.Join(tok, " "), "…"))
		if title == "" {
			title = id
		}
		if !reWingetID.MatchString(id) {
			continue
		}
		items = append(items, Item{Channel: "winget", Name: id, Title: title, Current: current, Latest: latest, Source: source, Flags: Flags{Explicit: explicit}})
	}
	return items
}

func ParseWindowsUpdate(text, rebootPending string) []Badge {
	out := []Badge{}
	var titles []string
	for _, l := range strings.Split(text, "\n") {
		if t := strings.TrimSpace(l); t != "" {
			titles = append(titles, t)
		}
	}
	if len(titles) > 0 {
		out = append(out, Badge{Channel: "windows-update", Title: "Windows Update", Count: len(titles), Titles: titles})
	}
	if strings.TrimSpace(rebootPending) == "1" {
		out = append(out, Badge{Channel: "windows-update", Title: "Reboot pending", Reboot: true})
	}
	return out
}

// ---- Linux ----

func flatpakRows(text string) [][]string {
	var rows [][]string
	for _, line := range strings.Split(text, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var cols []string
		if strings.Contains(line, "\t") {
			cols = strings.Split(line, "\t")
		} else {
			cols = regexp.MustCompile(`\s{2,}`).Split(strings.TrimSpace(line), -1)
		}
		for i := range cols {
			cols[i] = strings.TrimSpace(cols[i])
		}
		if regexp.MustCompile(`(?i)^Application( ID)?$`).MatchString(cols[0]) {
			continue
		}
		for len(cols) < 3 {
			cols = append(cols, "")
		}
		rows = append(rows, cols)
	}
	return rows
}

func ParseFlatpak(updates, list, scope string) []Item {
	installed := map[string]string{}
	for _, r := range flatpakRows(list) {
		installed[r[0]+"//"+r[1]] = r[2]
	}
	items := []Item{}
	for _, r := range flatpakRows(updates) {
		if r[0] == "" {
			continue
		}
		name := r[0]
		if r[1] != "" {
			name = r[0] + "//" + r[1]
		}
		items = append(items, Item{Channel: "flatpak-" + scope, Name: name, Title: r[0], Current: installed[r[0]+"//"+r[1]], Latest: r[2]})
	}
	return items
}

func ParseRpmOstree(text string) []Badge {
	var j struct {
		Deployments []struct {
			Version string `json:"version"`
			Booted  bool   `json:"booted"`
			Staged  bool   `json:"staged"`
		} `json:"deployments"`
		Cached *struct {
			Version string `json:"version"`
		} `json:"cached-update"`
	}
	out := []Badge{}
	if !decodeJSON(text, &j) {
		return out
	}
	stagedVersion := ""
	for _, d := range j.Deployments {
		if d.Staged && !d.Booted {
			stagedVersion = d.Version
			out = append(out, Badge{Channel: "rpm-ostree", Title: strings.TrimSpace("System update " + d.Version), Restart: true, Staged: true})
			break
		}
	}
	if j.Cached != nil && (stagedVersion == "" || j.Cached.Version != stagedVersion) {
		out = append(out, Badge{Channel: "rpm-ostree", Title: strings.TrimSpace("System update " + j.Cached.Version), Restart: true})
	}
	return out
}

// ---- Dockge ----

func ImageTag(ref string) string {
	base := ref
	if i := strings.Index(ref, "@"); i >= 0 {
		base = ref[:i]
	}
	slash := strings.LastIndex(base, "/")
	colon := strings.LastIndex(base, ":")
	if colon > slash {
		return base[colon+1:]
	}
	return "latest"
}

var (
	reDigestRef  = regexp.MustCompile(`(?i)@sha256:[0-9a-f]+`)
	reDotVersion = regexp.MustCompile(`(^|[^0-9.])v?\d+\.\d+`)
	reCommitTag  = regexp.MustCompile(`(?i)^(sha-)?[0-9a-f]{7,40}$`)
	reHasAF      = regexp.MustCompile(`(?i)[a-f]`)
	reHasDigit   = regexp.MustCompile(`\d`)
	reMajor      = regexp.MustCompile(`^v?(\d+)$`)
	reDigest     = regexp.MustCompile(`(?i)sha256:[0-9a-f]{64}`)
)

// IsPinnedRef: digest refs, exact version tags (2.5, v1.104.1) and commit tags (sha-fc4319c).
func IsPinnedRef(ref string) bool {
	if reDigestRef.MatchString(ref) {
		return true
	}
	tag := ImageTag(ref)
	if reDotVersion.MatchString(tag) {
		return true
	}
	return reCommitTag.MatchString(tag) && reHasAF.MatchString(tag) && reHasDigit.MatchString(tag)
}

// MajorOf: a major-only tag (postgres:17) is compared within its major; the tag never changes.
func MajorOf(ref string) string {
	if strings.Contains(ref, "@") {
		return ""
	}
	if m := reMajor.FindStringSubmatch(ImageTag(ref)); m != nil {
		return m[1]
	}
	return ""
}

func digestOf(s string) string {
	return strings.ToLower(reDigest.FindString(s))
}

func shortDigest(d string) string {
	d = strings.TrimPrefix(d, "sha256:")
	if len(d) > 12 {
		return d[:12]
	}
	return d
}

// ParseDockge: services lines `stack, service, ref, image id, state, repo digests (comma) or -`
// and registry lines `ref, sha256:... | error, message`, tab separated.
func ParseDockge(servicesText, registryText string) []Item {
	type reg struct{ digest, err string }
	registry := map[string]reg{}
	for _, line := range strings.Split(registryText, "\n") {
		c := strings.Split(line, "\t")
		if strings.TrimSpace(c[0]) == "" {
			continue
		}
		d := ""
		if len(c) > 1 {
			d = digestOf(c[1])
		}
		if d != "" {
			registry[strings.TrimSpace(c[0])] = reg{digest: d}
		} else {
			msg := "error"
			if len(c) > 2 {
				msg = strings.TrimSpace(c[2])
			} else if len(c) > 1 {
				msg = strings.TrimSpace(c[1])
			}
			registry[strings.TrimSpace(c[0])] = reg{err: msg}
		}
	}
	type svc struct {
		Service
		state   string
		digests []string
	}
	order := []string{}
	stacks := map[string][]svc{}
	for _, line := range strings.Split(servicesText, "\n") {
		c := strings.Split(line, "\t")
		if len(c) < 2 || strings.TrimSpace(c[0]) == "" {
			continue
		}
		for len(c) < 6 {
			c = append(c, "")
		}
		for i := range c {
			c[i] = strings.TrimSpace(c[i])
		}
		stack := c[0]
		if _, ok := stacks[stack]; !ok {
			order = append(order, stack)
			stacks[stack] = nil
		}
		if c[1] == "" || c[1] == "-" {
			continue
		}
		var digests []string
		if c[5] != "" && c[5] != "-" {
			for _, d := range strings.Split(c[5], ",") {
				if x := digestOf(d); x != "" {
					digests = append(digests, x)
				}
			}
		}
		stacks[stack] = append(stacks[stack], svc{Service: Service{Service: c[1], Ref: c[2]}, state: c[4], digests: digests})
	}
	items := []Item{}
	for _, stack := range order {
		services := stacks[stack]
		var f Flags
		current, latest := "", ""
		if len(services) == 0 {
			f.NotRunning = true
		}
		allStopped := len(services) > 0
		for i := range services {
			s := &services[i]
			if s.state == "running" || s.state == "" {
				allStopped = false
			}
			s.Pinned = IsPinnedRef(s.Ref)
			if !s.Pinned {
				s.Major = MajorOf(s.Ref)
			}
			s.Local = len(s.digests) == 0
			if s.Pinned {
				f.PinnedRef = true
			}
			if s.Major != "" && !contains(f.Majors, s.Major) {
				f.Majors = append(f.Majors, s.Major)
			}
			if s.Local {
				f.Local = true
				continue
			}
			r, ok := registry[s.Ref]
			if !ok {
				continue
			}
			if r.err != "" {
				s.CheckFailed = r.err
				f.CheckFailed = true
				continue
			}
			s.Update = !contains(s.digests, r.digest)
			if s.Update {
				f.Update = true
				if current == "" {
					current = shortDigest(s.digests[0])
					latest = shortDigest(r.digest)
				}
			}
		}
		if allStopped {
			f.NotRunning = true
		}
		out := make([]Service, len(services))
		for i, s := range services {
			out[i] = s.Service
		}
		items = append(items, Item{Channel: "dockge", Name: stack, Title: stack, Current: current, Latest: latest, Flags: f, Services: out})
	}
	sort.Slice(items, func(a, b int) bool { return items[a].Name < items[b].Name })
	return items
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
