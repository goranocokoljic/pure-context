package com.example;

import io.micronaut.http.annotation.*;
import io.micronaut.http.client.annotation.Client;
import java.util.List;

/**
 * Declarative HTTP client for the user service.
 * @Client marks this interface as a Micronaut HTTP client.
 */
@Client("/users")
public interface UserClient {

    @Get
    List<User> listUsers();

    @Get("/{id}")
    User getUser(Long id);

    @Post
    User createUser(User user);
}

@Client("/api/v1")
interface ApiClient {

    @Get("/health")
    String health();

    @Get("/version")
    String version();
}
