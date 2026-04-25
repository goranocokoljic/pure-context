package main

import (
	"net/http"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

func AuthMiddleware(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		return next(c)
	}
}

func main() {
	e := echo.New()

	// Global middleware
	e.Use(middleware.Logger())
	e.Use(AuthMiddleware)

	// Basic routes
	e.GET("/health", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]string{"status": "ok"})
	})

	e.GET("/users", listUsers)
	e.POST("/users", createUser)
	e.GET("/users/:id", getUser)
	e.PUT("/users/:id", updateUser)
	e.DELETE("/users/:id", deleteUser)

	// Group
	api := e.Group("/api")
	{
		api.GET("/items", listItems)
		api.POST("/items", createItem)
		api.GET("/items/:id", getItem)
	}

	e.Start(":8080")
}

func listUsers(c echo.Context) error  { return c.JSON(200, map[string]interface{}{"users": []string{}}) }
func createUser(c echo.Context) error { return c.JSON(201, map[string]interface{}{"created": true}) }
func getUser(c echo.Context) error    { return c.JSON(200, map[string]interface{}{"id": c.Param("id")}) }
func updateUser(c echo.Context) error { return c.JSON(200, map[string]interface{}{"updated": true}) }
func deleteUser(c echo.Context) error { return c.JSON(204, nil) }
func listItems(c echo.Context) error  { return c.JSON(200, map[string]interface{}{"items": []string{}}) }
func createItem(c echo.Context) error { return c.JSON(201, map[string]interface{}{"created": true}) }
func getItem(c echo.Context) error    { return c.JSON(200, map[string]interface{}{"id": c.Param("id")}) }
