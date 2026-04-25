package com.example;

import jakarta.persistence.*;
import java.time.LocalDate;
import java.util.List;

/**
 * User entity — demonstrates @Entity, @Table, @Id, @GeneratedValue,
 * @Column, @OneToMany, and @NamedQuery.
 */
@Entity
@Table(name = "users")
@NamedQuery(name = "User.findByEmail", query = "SELECT u FROM User u WHERE u.email = :email")
@NamedQuery(name = "User.findActive", query = "SELECT u FROM User u WHERE u.active = true")
public class User {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "email", nullable = false)
    private String email;

    @Column(name = "full_name")
    private String fullName;

    @Column(name = "birth_date")
    private LocalDate birthDate;

    @Column(nullable = false)
    private Boolean active;

    @OneToMany(mappedBy = "user", cascade = CascadeType.ALL)
    private List<Order> orders;

    // Getters/setters omitted for brevity
    public Long getId() { return id; }
    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }
}
