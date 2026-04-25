package com.example;

import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Singleton;
import io.quarkus.scheduler.Scheduled;
import io.quarkus.vertx.web.Route;
import java.util.ArrayList;
import java.util.List;

/**
 * Quarkus service bean and reactive route demonstration.
 */
@ApplicationScoped
public class UserService {

    private final List<User> users = new ArrayList<>();

    public List<User> findAll() {
        return users;
    }

    public User findById(Long id) {
        return users.stream().filter(u -> u.getId().equals(id)).findFirst().orElse(null);
    }

    @Scheduled(every = "1h")
    public void cleanupExpiredSessions() {
        // periodic cleanup
    }

    @Scheduled(cron = "0 0 * * *")
    public void nightly() {
        // nightly job
    }

    @Route(path = "/health")
    public void health(io.vertx.ext.web.RoutingContext rc) {
        rc.response().end("UP");
    }
}

@Singleton
public class UserRepository {

    public User save(User user) {
        return user;
    }

    public void delete(Long id) {}
}

@io.quarkus.arc.DefaultBean
class DefaultUserFactory {
    @io.quarkus.arc.DefaultBean
    public UserService defaultService() {
        return new UserService();
    }
}
