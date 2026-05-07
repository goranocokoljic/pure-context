SELECT
    o.id AS order_id,
    o.customer_id,
    o.amount,
    c.first_name,
    c.last_name
FROM {{ ref('stg_orders') }} o
JOIN {{ ref('stg_customers') }} c ON o.customer_id = c.customer_id
