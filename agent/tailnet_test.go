package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestTailscaleStatus(t *testing.T) {
	tn := ParseTailscaleStatus(read(t, "mac/tailscale-status.json"))
	if tn == nil || tn.Self == nil {
		t.Fatal("no tailnet")
	}
	if strings.Join(tn.Self.Names, ",") != "Example MacBook,mbp" || strings.Join(tn.Self.IPs, ",") != "100.64.0.21" {
		t.Fatalf("self %+v", tn.Self)
	}
	by := map[string]TailnetNode{}
	for _, p := range tn.Peers {
		for _, ip := range p.IPs {
			if !strings.HasPrefix(ip, "100.") || strings.Contains(ip, ":") {
				t.Fatalf("not a 100.x address: %s", ip)
			}
		}
		for _, n := range p.Names {
			if strings.EqualFold(n, "localhost") {
				t.Fatal("localhost kept as a name")
			}
		}
		by[p.Names[0]] = p
	}
	if a := by["axial"]; strings.Join(a.IPs, ",") != "100.64.0.17" || !a.Online || len(a.Names) != 1 {
		t.Fatalf("axial %+v", a)
	}
	// HostName and the DNS label both kept when they differ.
	if v := by["vps-8e6f2b1"]; strings.Join(v.Names, ",") != "vps-8e6f2b1,vps" {
		t.Fatalf("vps %+v", v)
	}
	// Android peers called localhost keep their DNS label only.
	if _, ok := by["google-pixel-7a"]; !ok {
		t.Fatal("pixel by DNS label")
	}
	if len(tn.Peers) != 10 {
		t.Fatalf("%d peers", len(tn.Peers))
	}
}

func TestTailscaleStatusMissing(t *testing.T) {
	for _, s := range []string{"", "not json", `{"BackendState":"Stopped","Self":{"HostName":"x","TailscaleIPs":["100.64.0.1"]}}`, `{"BackendState":"Running"}`} {
		if ParseTailscaleStatus(s) != nil {
			t.Fatalf("%q gave a tailnet", s)
		}
	}
	e := &Env{Fixtures: "../test/fixtures/linux"}
	if e.Tailnet() != nil {
		t.Fatal("no fixture should mean no section")
	}
}

func TestReportCarriesTailnetSigned(t *testing.T) {
	sk, _ := NewSecretKey()
	tn := ParseTailscaleStatus(read(t, "mac/tailscale-status.json"))
	ev, err := ReportEvent("m1", ReportContent{OS: "mac", Tailnet: tn}, 1700000000, sk)
	if err != nil || !VerifyEvent(ev) {
		t.Fatal("sign")
	}
	if !strings.Contains(ev.Content, `"tailnet":{"self"`) {
		t.Fatal("tailnet not in content")
	}
	// Changing the section breaks the signature: it is part of what is signed.
	var c map[string]any
	json.Unmarshal([]byte(ev.Content), &c)
	c["tailnet"] = map[string]any{"peers": []any{}}
	b, _ := json.Marshal(c)
	ev.Content = string(b)
	if VerifyEvent(ev) {
		t.Fatal("altered tailnet still verifies")
	}
	// Without Tailscale the field is not there at all (what old servers and agents expect).
	ev, _ = ReportEvent("m1", ReportContent{OS: "mac"}, 1700000000, sk)
	if strings.Contains(ev.Content, "tailnet") {
		t.Fatal("empty tailnet sent")
	}
}
