package com.example

import org.springframework.web.bind.annotation.*

@RestController
@RequestMapping("/users")
class UserController(private val userService: UserService) {

    @GetMapping
    fun listUsers(): List<User> = userService.findAll()

    @GetMapping("/{id}")
    fun getUser(@PathVariable id: Long): User = userService.findById(id)

    @PostMapping
    fun createUser(@RequestBody user: User): User = userService.save(user)

    @PutMapping("/{id}")
    fun updateUser(@PathVariable id: Long, @RequestBody user: User): User =
        userService.update(id, user)

    @DeleteMapping("/{id}")
    fun deleteUser(@PathVariable id: Long) = userService.delete(id)
}

@RestController
@RequestMapping("/api/v1")
class ApiController {

    @GetMapping("/health")
    fun health(): String = "OK"

    @GetMapping("/version")
    fun version(): String = "1.0.0"
}

@Controller
class PageController {

    @GetMapping("/")
    fun index(): String = "index"

    @GetMapping("/about")
    fun about(): String = "about"
}
