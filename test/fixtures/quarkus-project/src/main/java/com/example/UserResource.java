package com.example;

import jakarta.ws.rs.*;
import jakarta.ws.rs.core.MediaType;
import jakarta.enterprise.context.ApplicationScoped;
import java.util.List;

/**
 * JAX-RS resource demonstrating Quarkus route annotations.
 * Class-level @Path sets the base path; method annotations define HTTP methods.
 */
@Path("/users")
@ApplicationScoped
public class UserResource {

    @GET
    @Produces(MediaType.APPLICATION_JSON)
    public List<User> listUsers() {
        return List.of();
    }

    @GET
    @Path("/{id}")
    public User getUser(Long id) {
        return null;
    }

    @POST
    @Consumes(MediaType.APPLICATION_JSON)
    public User createUser(User user) {
        return user;
    }

    @PUT
    @Path("/{id}")
    public User updateUser(Long id, User user) {
        return user;
    }

    @DELETE
    @Path("/{id}")
    public void deleteUser(Long id) {}
}

@Path("/orders")
class OrderResource {

    @GET
    public List<Object> listOrders() {
        return List.of();
    }

    @POST
    public Object createOrder(Object order) {
        return order;
    }
}
