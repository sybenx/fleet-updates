//go:build !windows

package main

import "time"

func lowerPriority() {}

// listProcesses: one command line per line.
func listProcesses() string {
	out, _ := cmd(time.Minute, false, "ps", "-eo", "args=")
	return out
}
