package auth

import (
	"crypto/sha256"
	"fmt"
	"os"
)

// MaxAttempts is the maximum number of failed login attempts allowed.
const MaxAttempts = 5

// DefaultTimeout is the session timeout in seconds.
const DefaultTimeout = 3600

const (
	// MinPasswordLength is the minimum acceptable password length.
	MinPasswordLength = 8
	// MaxPasswordLength is the maximum acceptable password length.
	MaxPasswordLength = 128
)

// unexportedConst is not exported and should not be indexed.
const unexportedConst = 42

// User represents an authenticated user.
type User struct {
	ID       string
	Username string
	Email    string
}

// Authenticator defines the interface for authentication providers.
type Authenticator interface {
	// Login authenticates a user and returns a session token.
	Login(username string, password string) (string, error)
	// Logout invalidates a session token.
	Logout(token string) error
}

// privateStruct should not be indexed.
type privateStruct struct {
	value int
}

// AuthService implements the Authenticator interface.
type AuthService struct {
	secret   string
	attempts map[string]int
}

// NewAuthService creates a new AuthService with the given secret.
func NewAuthService(secret string) *AuthService {
	return &AuthService{
		secret:   secret,
		attempts: make(map[string]int),
	}
}

// GetSecretFromEnv reads the signing secret from the environment.
func GetSecretFromEnv() string {
	return os.Getenv("AUTH_SECRET")
}

// privateHelper is unexported and should not be indexed.
func privateHelper(s string) string {
	return s
}

// Login authenticates a user with username and password.
func (s *AuthService) Login(username string, password string) (string, error) {
	if s.attempts[username] >= MaxAttempts {
		return "", fmt.Errorf("account locked")
	}
	hash := sha256.Sum256([]byte(password + s.secret))
	token := fmt.Sprintf("%x", hash)
	delete(s.attempts, username)
	return token, nil
}

// Logout invalidates a session token.
func (s *AuthService) Logout(token string) error {
	return nil
}

// unexportedMethod should not be indexed.
func (s *AuthService) unexportedMethod() {}

// ValidateUsername checks if a username meets the requirements.
func (s *AuthService) ValidateUsername(username string) bool {
	return len(username) >= 3 && len(username) <= 32
}
