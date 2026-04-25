package main

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

func AuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()
	}
}

func Logger() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()
	}
}

func main() {
	r := gin.Default()

	// Global middleware
	r.Use(AuthMiddleware)
	r.Use(Logger)

	// Basic routes
	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	r.GET("/users", listUsers)
	r.POST("/users", createUser)
	r.GET("/users/:id", getUser)
	r.PUT("/users/:id", updateUser)
	r.DELETE("/users/:id", deleteUser)
	r.PATCH("/users/:id", patchUser)

	// API version group
	v1 := r.Group("/v1")
	{
		v1.GET("/items", listItems)
		v1.POST("/items", createItem)
		v1.GET("/items/:id", getItem)
	}

	r.Run(":8080")
}

func listUsers(c *gin.Context)  { c.JSON(200, gin.H{"users": []string{}}) }
func createUser(c *gin.Context) { c.JSON(201, gin.H{"created": true}) }
func getUser(c *gin.Context)    { c.JSON(200, gin.H{"id": c.Param("id")}) }
func updateUser(c *gin.Context) { c.JSON(200, gin.H{"updated": true}) }
func deleteUser(c *gin.Context) { c.JSON(204, nil) }
func patchUser(c *gin.Context)  { c.JSON(200, gin.H{"patched": true}) }
func listItems(c *gin.Context)  { c.JSON(200, gin.H{"items": []string{}}) }
func createItem(c *gin.Context) { c.JSON(201, gin.H{"created": true}) }
func getItem(c *gin.Context)    { c.JSON(200, gin.H{"id": c.Param("id")}) }
