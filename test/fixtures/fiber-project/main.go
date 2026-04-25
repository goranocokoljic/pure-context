package main

import (
	"github.com/gofiber/fiber/v2"
)

func AuthMiddleware(c *fiber.Ctx) error {
	return c.Next()
}

func main() {
	app := fiber.New()

	// Global middleware
	app.Use(AuthMiddleware)

	// Basic routes
	app.Get("/health", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "ok"})
	})

	app.Get("/users", listUsers)
	app.Post("/users", createUser)
	app.Get("/users/:id", getUser)
	app.Put("/users/:id", updateUser)
	app.Delete("/users/:id", deleteUser)

	// Group
	api := app.Group("/api")
	api.Get("/items", listItems)
	api.Post("/items", createItem)
	api.Get("/items/:id", getItem)

	app.Listen(":3000")
}

func listUsers(c *fiber.Ctx) error  { return c.JSON(fiber.Map{"users": []string{}}) }
func createUser(c *fiber.Ctx) error { return c.JSON(fiber.Map{"created": true}) }
func getUser(c *fiber.Ctx) error    { return c.JSON(fiber.Map{"id": c.Params("id")}) }
func updateUser(c *fiber.Ctx) error { return c.JSON(fiber.Map{"updated": true}) }
func deleteUser(c *fiber.Ctx) error { return c.SendStatus(204) }
func listItems(c *fiber.Ctx) error  { return c.JSON(fiber.Map{"items": []string{}}) }
func createItem(c *fiber.Ctx) error { return c.JSON(fiber.Map{"created": true}) }
func getItem(c *fiber.Ctx) error    { return c.JSON(fiber.Map{"id": c.Params("id")}) }
