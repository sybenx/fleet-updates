package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// State is everything the agent keeps between runs, in one file only this user can read.
type State struct {
	URL           string               `json:"url"`
	MachineID     string               `json:"machine_id"`
	Approver      string               `json:"approver"`
	SecretKey     string               `json:"secret_key"`
	OS            string               `json:"os"`
	LastCounter   int64                `json:"last_counter"`
	PolicyCounter int64                `json:"policy_counter"`
	AskFirst      []string             `json:"ask_first"`
	CaskSeen      map[string]int64     `json:"cask_seen"`
	Applied       []Applied            `json:"applied"`
	Items         []Item               `json:"items"`
	Badges        []Badge              `json:"badges"`
	CheckedAt     int64                `json:"checked_at"`
	Registry      map[string]RegDigest `json:"registry,omitempty"`
}

type RegDigest struct {
	Digest string `json:"digest"`
	At     int64  `json:"at"`
}

// Java runtimes: the Minecraft servers on Took run on Java. A signed approval can replace this list.
var DefaultAskFirst = []string{"EclipseAdoptium.*", "Oracle.JDK.*", "Oracle.JavaRuntimeEnvironment", "Microsoft.OpenJDK.*"}

func defaultStateDir(osName string) string {
	if d := os.Getenv("FLEET_STATE_DIR"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	switch {
	case osName == "dockge":
		return "/state"
	case runtime.GOOS == "darwin":
		return filepath.Join(home, "Library", "Application Support", "FleetAgent")
	case runtime.GOOS == "windows":
		return filepath.Join(os.Getenv("LOCALAPPDATA"), "FleetAgent")
	default:
		if x := os.Getenv("XDG_STATE_HOME"); x != "" {
			return filepath.Join(x, "fleet-agent")
		}
		return filepath.Join(home, ".local", "state", "fleet-agent")
	}
}

func loadState(dir string) (*State, error) {
	b, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err != nil {
		return nil, err
	}
	var s State
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, err
	}
	if s.CaskSeen == nil {
		s.CaskSeen = map[string]int64{}
	}
	if s.Registry == nil {
		s.Registry = map[string]RegDigest{}
	}
	if s.AskFirst == nil {
		s.AskFirst = append([]string{}, DefaultAskFirst...)
	}
	return &s, nil
}

func saveState(dir string, s *State) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s, "", " ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(dir, "state.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, "state.json"))
}

// One run at a time; a lock older than 3 hours is left from a crash.
func lock(dir string) (func(), error) {
	p := filepath.Join(dir, "run.lock")
	for i := 0; i < 2; i++ {
		f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			f.Close()
			return func() { os.Remove(p) }, nil
		}
		if st, e := os.Stat(p); e == nil && time.Since(st.ModTime()) > 3*time.Hour {
			os.Remove(p)
			continue
		}
		return nil, errors.New("another run is going")
	}
	return nil, errors.New("lock")
}

func matchesAskFirst(id string, list []string) bool {
	l := strings.ToLower(id)
	for _, p := range list {
		q := strings.ToLower(p)
		if strings.HasSuffix(q, "*") {
			if strings.HasPrefix(l, strings.TrimSuffix(q, "*")) {
				return true
			}
		} else if l == q {
			return true
		}
	}
	return false
}
