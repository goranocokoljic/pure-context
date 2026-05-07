{% docs stg_customers %}
Staged customer data cleaned from the raw source layer.
Includes deduplication and null handling.
{% enddocs %}

{% docs orders %}
Final orders mart. Joins order transactions with customer dimensions.
Used by finance team for reporting.
{% enddocs %}
