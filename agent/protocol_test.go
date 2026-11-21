package main

import (
	"encoding/json"
	"os"
	"testing"
)

type vectors struct {
	Approver   string            `json:"approver"`
	Other      string            `json:"other"`
	Now        int64             `json:"now"`
	Items      []Item            `json:"items"`
	ReportHash string            `json:"report_hash"`
	ItemIDs    map[string]string `json:"item_ids"`
	Approval   Event             `json:"approval"`
	ByOther    Event             `json:"approval_by_other"`
	Odd        Event             `json:"odd_event"`
}

func loadVectors(t *testing.T) vectors {
	b, err := os.ReadFile("../test/fixtures/protocol/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// The Node side and this side must agree on ids, hashes and signatures.
func TestVectorsFromNode(t *testing.T) {
	v := loadVectors(t)
	if got := ReportHash("mac", v.Items); got != v.ReportHash {
		t.Fatalf("report hash %s, node says %s", got, v.ReportHash)
	}
	for _, it := range v.Items {
		if got := ItemID(it.Channel, it.Name); got != v.ItemIDs[it.Channel+"|"+it.Name] {
			t.Fatalf("item id for %s: %s", it.Name, got)
		}
	}
	if EventID(&v.Odd) != v.Odd.ID {
		t.Fatalf("event id with escapes: %s, node says %s", EventID(&v.Odd), v.Odd.ID)
	}
	if !VerifyEvent(&v.Approval) {
		t.Fatal("approval signed by node does not verify")
	}
	a := CheckApproval(&v.Approval, v.Approver, "abcd1234", 4, v.ReportHash, v.Now+10)
	if !a.OK {
		t.Fatalf("approval not ok: %s", a.Reason)
	}
	if a.Counter != 5 || len(a.Only) != 1 || a.Only[0] != v.ItemIDs["brew-formula|jq"] || a.Overrides["dozzle"] != "compare" || a.AskFirst[0] != "Valve.Steam" {
		t.Fatalf("fields: %+v", a)
	}
}

func signedApproval(t *testing.T, sk, machine, hash string, counter, created, exp int64) *Event {
	ev := &Event{CreatedAt: created, Kind: ApprovalKind, Tags: [][]string{{"d", machine}, {"report", hash}, {"counter", itoa(counter)}, {"expiration", itoa(exp)}}}
	if err := SignEvent(ev, sk); err != nil {
		t.Fatal(err)
	}
	return ev
}

func itoa(n int64) string { b, _ := json.Marshal(n); return string(b) }

func TestApprovalChecks(t *testing.T) {
	v := loadVectors(t)
	sk := "0000000000000000000000000000000000000000000000000000000000000003"
	now := v.Now
	good := signedApproval(t, sk, "m1", v.ReportHash, 10, now, now+3600)
	cases := []struct {
		name   string
		ev     *Event
		last   int64
		hash   string
		now    int64
		reason string
	}{
		{"good", good, 9, v.ReportHash, now, ""},
		{"replayed approval (old counter)", good, 10, v.ReportHash, now, "old counter"},
		{"replayed approval (older counter)", good, 11, v.ReportHash, now, "old counter"},
		{"expired", good, 9, v.ReportHash, now + 3600, "expired"},
		{"hash does not match the current report", good, 9, ReportHash("mac", v.Items[:1]), now, "report changed"},
		{"unknown signer", &v.ByOther, 0, v.ReportHash, v.Now, "unknown signer"},
		{"for another machine", signedApproval(t, sk, "m2", v.ReportHash, 12, now, now+3600), 9, v.ReportHash, now, "for another machine"},
		{"from the future", signedApproval(t, sk, "m1", v.ReportHash, 12, now+700, now+3600), 9, v.ReportHash, now, "from the future"},
	}
	for _, c := range cases {
		machine := "m1"
		if c.ev == &v.ByOther {
			machine = "abcd1234"
		}
		a := CheckApproval(c.ev, v.Approver, machine, c.last, c.hash, c.now)
		if (c.reason == "") != a.OK || a.Reason != c.reason {
			t.Errorf("%s: ok=%v reason=%q", c.name, a.OK, a.Reason)
		}
	}
	// Tampered: a changed tag breaks the id, a changed id breaks the signature.
	bad := *good
	bad.Tags = append([][]string{}, good.Tags...)
	bad.Tags[2] = []string{"counter", "99"}
	if a := CheckApproval(&bad, v.Approver, "m1", 0, v.ReportHash, now); a.Reason != "bad signature" {
		t.Errorf("tampered: %q", a.Reason)
	}
	if a := CheckApproval(nil, v.Approver, "m1", 0, v.ReportHash, now); a.OK {
		t.Error("nil approval ok")
	}
}

func TestReportSignedHereVerifies(t *testing.T) {
	sk, _ := NewSecretKey()
	items := []Item{{Channel: "brew-formula", Name: "jq", Current: "1.7", Latest: "1.7.1"}}
	ev, err := ReportEvent("m1", ReportContent{OS: "mac", Host: "h", Items: items}, 1795000000, sk)
	if err != nil || !VerifyEvent(ev) {
		t.Fatal("report does not verify")
	}
	if ev.Tag("report") != ReportHash("mac", items) || ev.Kind != ReportKind || ev.Tag("d") != "m1" {
		t.Fatal("tags")
	}
}

func TestPolicyFromApproval(t *testing.T) {
	v := loadVectors(t)
	p, ok := PolicyFrom(&v.Approval, v.Approver, "abcd1234", 0, v.Now)
	if !ok || p.AskFirst[0] != "Valve.Steam" {
		t.Fatal("policy from a valid approval")
	}
	if _, ok := PolicyFrom(&v.Approval, v.Approver, "abcd1234", 5, v.Now); ok {
		t.Fatal("old policy taken")
	}
	if _, ok := PolicyFrom(&v.ByOther, v.Approver, "abcd1234", 0, v.Now); ok {
		t.Fatal("policy from unknown signer taken")
	}
}
