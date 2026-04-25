package com.example;

import jakarta.persistence.*;
import java.math.BigDecimal;

/**
 * Product entity — demonstrates a simple entity with default table name
 * (snake_case of class name) and @OneToOne relationship.
 */
@Entity
public class Product {

    @Id
    @GeneratedValue(strategy = GenerationType.AUTO)
    private Long id;

    @Column(nullable = false)
    private String name;

    @Column(name = "unit_price", nullable = false)
    private BigDecimal unitPrice;

    @Column
    private Integer stock;

    @OneToOne(cascade = CascadeType.ALL)
    @JoinColumn(name = "detail_id")
    private ProductDetail detail;

    public Long getId() { return id; }
    public String getName() { return name; }
}
