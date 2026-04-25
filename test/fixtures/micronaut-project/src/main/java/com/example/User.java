package com.example;

/** Simple user domain object. */
public class User {
    private Long id;
    private String name;
    private String email;

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }
}

class UserCreatedEvent {
    private final User user;
    public UserCreatedEvent(User user) { this.user = user; }
    public User getUser() { return user; }
}

class UserDeletedEvent {
    private final Long userId;
    public UserDeletedEvent(Long userId) { this.userId = userId; }
    public Long getUserId() { return userId; }
}
