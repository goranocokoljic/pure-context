// Package main is the entry point for the application.
package main

import (
	"fmt"
	"os"

	"github.com/example/myapp/pkg/auth"
	"github.com/example/myapp/pkg/utils"
)

// Run initialises and starts the application.
func Run() error {
	service := auth.NewAuthService()
	token, err := service.Login("admin", os.Getenv("APP_SECRET"))
	if err != nil {
		return fmt.Errorf("login failed: %w", err)
	}

	formatted := utils.FormatToken(token)
	fmt.Println("Started with token:", formatted)
	return nil
}

func main() {
	if err := Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
