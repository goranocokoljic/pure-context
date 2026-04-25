package com.example;

import io.micronaut.http.annotation.*;
import io.micronaut.http.HttpResponse;
import java.util.List;

/**
 * REST controller demonstrating Micronaut route annotations.
 * Class-level @Controller sets the base path; method annotations define routes.
 */
@Controller("/users")
public class UserController {

    @Get
    public List<User> listUsers() {
        return List.of();
    }

    @Get("/{id}")
    public HttpResponse<User> getUser(Long id) {
        return HttpResponse.ok();
    }

    @Post
    public HttpResponse<User> createUser(User user) {
        return HttpResponse.created(user);
    }

    @Put("/{id}")
    public HttpResponse<User> updateUser(Long id, User user) {
        return HttpResponse.ok(user);
    }

    @Delete("/{id}")
    public HttpResponse<Void> deleteUser(Long id) {
        return HttpResponse.noContent();
    }
}

@Controller("/api/v1")
class ApiController {

    @Get("/health")
    public String health() {
        return "UP";
    }

    @Get("/version")
    public String version() {
        return "1.0.0";
    }

    @Post("/echo")
    public String echo(String body) {
        return body;
    }
}
