//go:build windows

package main

import (
	"syscall"
	"time"
)

// Below Normal priority for the agent and everything it starts (children inherit it).
func lowerPriority() {
	k := syscall.NewLazyDLL("kernel32.dll")
	h, _, _ := k.NewProc("GetCurrentProcess").Call()
	k.NewProc("SetPriorityClass").Call(h, 0x00004000)
}

// listProcesses: name <tab> path <tab> command line, one process per line.
func listProcesses() string {
	out, _ := cmd(time.Minute, false, "powershell", "-NoProfile", "-NonInteractive", "-Command",
		"Get-CimInstance Win32_Process | ForEach-Object { '{0}`t{1}`t{2}' -f $_.Name, $_.ExecutablePath, ($_.CommandLine -replace \"[`t`r`n]\", ' ') }")
	return out
}
