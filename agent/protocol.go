package main

// The agent's side of server/protocol.js and PROTOCOL.md. Keep the three in step.

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"
)

const (
	ProtocolVersion = 1
	ReportKind      = 31748
	ApprovalKind    = 31747
	MaxFutureS      = 600
)

type Flags struct {
	Pinned      bool     `json:"pinned,omitempty"`
	Pkg         bool     `json:"pkg,omitempty"`
	Apps        []string `json:"apps,omitempty"`
	Running     bool     `json:"running,omitempty"`
	Explicit    bool     `json:"explicit,omitempty"`
	PinnedRef   bool     `json:"pinnedRef,omitempty"`
	Local       bool     `json:"local,omitempty"`
	NotRunning  bool     `json:"notRunning,omitempty"`
	Update      bool     `json:"update,omitempty"`
	Majors      []string `json:"majors,omitempty"`
	CheckFailed bool     `json:"checkFailed,omitempty"`
}

type Service struct {
	Service     string `json:"service"`
	Ref         string `json:"ref"`
	Pinned      bool   `json:"pinned"`
	Major       string `json:"major,omitempty"`
	Local       bool   `json:"local"`
	Update      bool   `json:"update"`
	CheckFailed string `json:"checkFailed,omitempty"`
}

type Item struct {
	Channel  string    `json:"channel"`
	Name     string    `json:"name"`
	Title    string    `json:"title"`
	Current  string    `json:"current"`
	Latest   string    `json:"latest"`
	Source   string    `json:"source,omitempty"`
	Flags    Flags     `json:"flags"`
	Services []Service `json:"services,omitempty"`
}

type Badge struct {
	Channel string   `json:"channel"`
	Title   string   `json:"title"`
	Version string   `json:"version,omitempty"`
	Restart bool     `json:"restart,omitempty"`
	Staged  bool     `json:"staged,omitempty"`
	Reboot  bool     `json:"reboot,omitempty"`
	Count   int      `json:"count,omitempty"`
	Titles  []string `json:"titles,omitempty"`
}

type Applied struct {
	At      string `json:"at"`
	How     string `json:"how"` // overnight | click
	Channel string `json:"channel"`
	Name    string `json:"name"`
	Title   string `json:"title"`
	From    string `json:"from"`
	To      string `json:"to"`
	Status  string `json:"status"`
	Message string `json:"message"`
}

func ItemID(channel, name string) string {
	return sha256Hex(channel + "\x00" + name)[:12]
}

// ReportHash: os and each item's channel, name, current and latest, sorted (see protocol.js).
func ReportHash(osName string, items []Item) string {
	rows := make([][]string, len(items))
	for i, it := range items {
		rows[i] = []string{it.Channel, it.Name, it.Current, it.Latest}
	}
	sort.Slice(rows, func(a, b int) bool { return strings.Join(rows[a], "\x00") < strings.Join(rows[b], "\x00") })
	return sha256Hex(canonicalJSON([]any{ProtocolVersion, osName, rows}))
}

type ReportContent struct {
	V           int       `json:"v"`
	OS          string    `json:"os"`
	Host        string    `json:"host"`
	Items       []Item    `json:"items"`
	Badges      []Badge   `json:"badges"`
	Applied     []Applied `json:"applied"`
	LastCounter int64     `json:"last_counter"`
	Uninstall   bool      `json:"uninstall,omitempty"`
}

func ReportEvent(machineID string, c ReportContent, createdAt int64, sk string) (*Event, error) {
	if c.Items == nil {
		c.Items = []Item{}
	}
	if c.Badges == nil {
		c.Badges = []Badge{}
	}
	if c.Applied == nil {
		c.Applied = []Applied{}
	}
	c.V = ProtocolVersion
	content, err := json.Marshal(c)
	if err != nil {
		return nil, err
	}
	ev := &Event{CreatedAt: createdAt, Kind: ReportKind, Tags: [][]string{{"d", machineID}, {"report", ReportHash(c.OS, c.Items)}}, Content: string(content)}
	return ev, SignEvent(ev, sk)
}

type Approval struct {
	OK         bool
	Reason     string
	Counter    int64
	Expiration int64
	Only       []string
	Overrides  map[string]string
	AskFirst   []string
	Report     string
}

func approvalFields(ev *Event) Approval {
	a := Approval{Overrides: map[string]string{}}
	a.Counter, _ = strconv.ParseInt(ev.Tag("counter"), 10, 64)
	a.Expiration, _ = strconv.ParseInt(ev.Tag("expiration"), 10, 64)
	a.Only = ev.TagValues("only")
	a.AskFirst = ev.TagValues("ask_first")
	a.Report = ev.Tag("report")
	for _, t := range ev.Tags {
		if len(t) >= 3 && t[0] == "override" {
			a.Overrides[t[1]] = t[2]
		}
	}
	return a
}

// CheckApproval: anything but ok means do nothing and report fresh.
func CheckApproval(ev *Event, approver, machineID string, lastCounter int64, localHash string, now int64) Approval {
	if ev == nil {
		return Approval{Reason: "no approval"}
	}
	if !VerifyEvent(ev) {
		return Approval{Reason: "bad signature"}
	}
	if ev.Pubkey != approver {
		return Approval{Reason: "unknown signer"}
	}
	if ev.Kind != ApprovalKind {
		return Approval{Reason: "wrong kind"}
	}
	a := approvalFields(ev)
	if ev.Tag("d") != machineID {
		a.Reason = "for another machine"
		return a
	}
	if a.Counter <= lastCounter {
		a.Reason = "old counter"
		return a
	}
	if a.Expiration == 0 || now >= a.Expiration {
		a.Reason = "expired"
		return a
	}
	if ev.CreatedAt > now+MaxFutureS {
		a.Reason = "from the future"
		return a
	}
	if a.Report != localHash {
		a.Reason = "report changed"
		return a
	}
	a.OK = true
	return a
}

// PolicyFrom: an approval that is signed by the approver, for this machine, newer and not expired
// carries policy (the winget ask-first list) even when its hash no longer matches.
func PolicyFrom(ev *Event, approver, machineID string, lastPolicyCounter, now int64) (Approval, bool) {
	if ev == nil || !VerifyEvent(ev) || ev.Pubkey != approver || ev.Kind != ApprovalKind || ev.Tag("d") != machineID {
		return Approval{}, false
	}
	a := approvalFields(ev)
	if a.Counter <= lastPolicyCounter || a.Expiration == 0 || now >= a.Expiration {
		return Approval{}, false
	}
	return a, true
}
