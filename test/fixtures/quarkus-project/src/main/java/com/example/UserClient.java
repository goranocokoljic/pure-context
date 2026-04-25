package com.example;

import org.eclipse.microprofile.rest.client.inject.RegisterRestClient;
import jakarta.ws.rs.*;
import java.util.List;

/**
 * Declarative REST clients using MicroProfile @RegisterRestClient.
 */
@RegisterRestClient(baseUri = "http://user-service/api")
@Path("/users")
public interface UserClient {

    @GET
    List<User> findAll();

    @GET
    @Path("/{id}")
    User findById(Long id);

    @POST
    User create(User user);
}

@RegisterRestClient(configKey = "order-service")
@Path("/orders")
interface OrderClient {

    @GET
    List<Object> findAll();

    @POST
    Object create(Object order);
}
