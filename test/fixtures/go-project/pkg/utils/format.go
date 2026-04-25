// Package utils provides general-purpose helper functions.
package utils

import (
	"fmt"
	"strings"
	"time"
)

const (
	// MaxTokenLength is the maximum allowed token length.
	MaxTokenLength = 256
	// DefaultPrefix is the default token prefix.
	DefaultPrefix = "tok_"
)

// FormatToken formats a raw token string for display.
func FormatToken(token string) string {
	if len(token) > MaxTokenLength {
		token = token[:MaxTokenLength]
	}
	return DefaultPrefix + token
}

// TruncateString shortens s to at most n characters, appending "..." if truncated.
func TruncateString(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// FormatTimestamp formats t as an ISO 8601 UTC string.
func FormatTimestamp(t time.Time) string {
	return t.UTC().Format(time.RFC3339)
}

// joinLines is an unexported helper — should NOT appear in the symbol index.
func joinLines(lines []string) string {
	return strings.Join(lines, "\n")
}

// formatError builds an error message string. Unexported — should be skipped.
func formatError(code int, msg string) string {
	return fmt.Sprintf("E%d: %s", code, msg)
}
