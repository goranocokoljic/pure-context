// Package models defines the domain data structures.
package models

import "time"

// Role represents a permission level within the system.
type Role string

const (
	// RoleAdmin grants full access.
	RoleAdmin Role = "admin"
	// RoleUser grants standard access.
	RoleUser Role = "user"
	// RoleGuest grants read-only access.
	RoleGuest Role = "guest"
)

// User represents an application user account.
type User struct {
	ID           string
	Username     string
	Email        string
	PasswordHash string
	IsActive     bool
	Roles        []Role
	CreatedAt    time.Time
}

// DisplayName returns the user's display name.
func (u *User) DisplayName() string {
	return u.Username
}

// HasRole reports whether the user has the given role.
func (u *User) HasRole(role Role) bool {
	for _, r := range u.Roles {
		if r == role {
			return true
		}
	}
	return false
}

// Deactivate marks the user account as inactive.
func (u *User) Deactivate() {
	u.IsActive = false
}

// AnonymousUser represents an unauthenticated visitor.
type AnonymousUser struct{}

// DisplayName returns the anonymous display name.
func (a *AnonymousUser) DisplayName() string {
	return "Anonymous"
}
