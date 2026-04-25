# Example script showing package usage
library(mypackage)

# Create a myclass instance
obj <- new_myclass(42)
print(obj)
summary(obj)

# Use utility functions
message(greet("World"))
message(format_date(Sys.time()))
message(truncate_string("A very long string that needs truncating", max = 20))
