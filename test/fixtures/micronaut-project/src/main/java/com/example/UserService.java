package com.example;

import io.micronaut.context.annotation.*;
import io.micronaut.runtime.event.annotation.EventListener;
import io.micronaut.scheduling.annotation.Scheduled;
import jakarta.inject.Singleton;
import java.util.List;

/**
 * Service bean registered in the Micronaut application context.
 * Demonstrates @Singleton, @Scheduled, and @EventListener patterns.
 */
@Singleton
public class UserService {

    public List<User> findAll() {
        return List.of();
    }

    public User save(User user) {
        return user;
    }

    @Scheduled(fixedDelay = "1h")
    public void cleanupExpiredSessions() {
        // periodic cleanup task
    }

    @EventListener
    public void onUserCreated(UserCreatedEvent event) {
        // handle user creation
    }

    @EventListener
    public void onUserDeleted(UserDeletedEvent event) {
        // handle user deletion
    }
}

@Singleton
class UserRepository {

    public List<User> findAll() {
        return List.of();
    }
}

@Factory
class AppFactory {

    @Bean
    public UserService userService() {
        return new UserService();
    }

    @Bean
    public UserRepository userRepository() {
        return new UserRepository();
    }
}
