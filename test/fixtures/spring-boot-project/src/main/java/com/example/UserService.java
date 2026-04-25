package com.example;

import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.stereotype.Repository;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public class UserService {

    private final UserRepository userRepository;

    public UserService(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    public List<User> findAll() {
        return userRepository.findAll();
    }

    public User findById(Long id) {
        return userRepository.findById(id);
    }

    public User save(User user) {
        return userRepository.save(user);
    }

    public User update(Long id, User user) {
        return userRepository.save(user);
    }

    public void delete(Long id) {
        userRepository.deleteById(id);
    }

    @Scheduled(fixedRate = 60000)
    public void cleanupExpiredSessions() {
        // periodic cleanup task
    }

    @EventListener
    public void onUserCreated(UserCreatedEvent event) {
        // handle user creation event
    }

    @EventListener
    public void onUserDeleted(UserDeletedEvent event) {
        // handle user deletion event
    }
}

@Repository
public class UserRepository {

    public List<User> findAll() {
        return List.of();
    }

    public User findById(Long id) {
        return new User(id, "John", "john@example.com");
    }

    public User save(User user) {
        return user;
    }

    public void deleteById(Long id) {}
}

@Component
public class AuditLogger {

    public void log(String message) {
        System.out.println("[AUDIT] " + message);
    }
}

record User(Long id, String name, String email) {}

record UserCreatedEvent(User user) {}

record UserDeletedEvent(Long userId) {}
