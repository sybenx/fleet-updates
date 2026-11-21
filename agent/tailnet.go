package main

// The optional `tailnet` section of a report: this machine's view of the tailnet, from
// `tailscale status --json`. The dashboard's container cannot resolve tailnet names, so it uses
// these to turn "axial" into a 100.x address and to look for Umbrels. No Tailscale CLI, or
// Tailscale not running: the section is left out. Never an error.

import (
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

type TailnetNode struct {
	Names  []string `json:"names"`
	IPs    []string `json:"ips"`
	Online bool     `json:"online,omitempty"`
}

type Tailnet struct {
	Self  *TailnetNode  `json:"self,omitempty"`
	Peers []TailnetNode `json:"peers"`
}

type tsNode struct {
	HostName     string
	DNSName      string
	TailscaleIPs []string
	Online       bool
}

// tailscaleIPv4 keeps 100.64.0.0/10 (CGNAT, what Tailscale hands out) addresses only.
func tailscaleIPv4(ips []string) []string {
	_, cgnat, _ := net.ParseCIDR("100.64.0.0/10")
	out := []string{}
	for _, s := range ips {
		ip := net.ParseIP(s)
		if ip != nil && ip.To4() != nil && cgnat.Contains(ip) {
			out = append(out, ip.To4().String())
		}
	}
	return out
}

func tailnetNode(n tsNode) (TailnetNode, bool) {
	t := TailnetNode{IPs: tailscaleIPv4(n.TailscaleIPs), Online: n.Online}
	seen := map[string]bool{}
	for _, name := range []string{n.HostName, strings.SplitN(n.DNSName, ".", 2)[0]} {
		name = strings.TrimSpace(name)
		k := strings.ToLower(name)
		// Android devices call themselves "localhost": not a name anyone can use.
		if name == "" || k == "localhost" || seen[k] || len(name) > 63 {
			continue
		}
		seen[k] = true
		t.Names = append(t.Names, name)
	}
	return t, len(t.IPs) > 0 && len(t.Names) > 0
}

// ParseTailscaleStatus: nil when the text is empty, not JSON, or Tailscale is not running.
func ParseTailscaleStatus(text string) *Tailnet {
	var s struct {
		BackendState string
		Self         *tsNode
		Peer         map[string]tsNode
	}
	if strings.TrimSpace(text) == "" || json.Unmarshal([]byte(text), &s) != nil {
		return nil
	}
	if s.BackendState != "" && s.BackendState != "Running" {
		return nil
	}
	t := &Tailnet{Peers: []TailnetNode{}}
	if s.Self != nil {
		if n, ok := tailnetNode(*s.Self); ok {
			t.Self = &n
		}
	}
	for _, p := range s.Peer {
		if n, ok := tailnetNode(p); ok {
			t.Peers = append(t.Peers, n)
		}
	}
	sort.Slice(t.Peers, func(a, b int) bool { return t.Peers[a].IPs[0] < t.Peers[b].IPs[0] })
	if t.Self == nil && len(t.Peers) == 0 {
		return nil
	}
	return t
}

func tailscaleBinary() string {
	if p, err := exec.LookPath("tailscale"); err == nil {
		return p
	}
	var cands []string
	switch runtime.GOOS {
	case "darwin":
		cands = []string{"/Applications/Tailscale.app/Contents/MacOS/Tailscale"}
	case "windows":
		cands = []string{filepath.Join(os.Getenv("ProgramFiles"), "Tailscale", "tailscale.exe"), `C:\Program Files\Tailscale\tailscale.exe`}
	}
	for _, c := range cands {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c
		}
	}
	return ""
}

// Tailnet: from the fixture file when there are fixtures, else from the CLI. nil when neither.
func (e *Env) Tailnet() *Tailnet {
	if e.Fixtures != "" {
		b, err := os.ReadFile(filepath.Join(e.Fixtures, "tailscale-status.json"))
		if err != nil {
			return nil
		}
		return ParseTailscaleStatus(string(b))
	}
	if e.OS == "dockge" {
		return nil
	}
	bin := tailscaleBinary()
	if bin == "" {
		return nil
	}
	out, code := cmd(20*time.Second, false, bin, "status", "--json")
	if code != 0 {
		return nil
	}
	return ParseTailscaleStatus(out)
}
