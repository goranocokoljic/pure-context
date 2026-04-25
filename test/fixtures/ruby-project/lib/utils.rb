require_relative './models/user'
require_relative './auth_service'

# Formats a number of bytes as a human-readable string.
def format_bytes(bytes)
  units = %w[B KB MB GB TB]
  idx = 0
  value = bytes.to_f
  while value >= 1024 && idx < units.length - 1
    value /= 1024.0
    idx += 1
  end
  "#{value.round(2)} #{units[idx]}"
end

# Converts a snake_case string to CamelCase.
def camelize(str)
  str.split('_').map(&:capitalize).join
end

# Returns true if the string is a valid email address (simple heuristic).
def valid_email?(str)
  str.is_a?(String) && str.include?('@') && str.include?('.')
end

# Clamps a numeric value within [min_val, max_val].
def clamp(value, min_val, max_val)
  [[value, min_val].max, max_val].min
end

# Retries a block up to +times+ times, re-raising on final failure.
def with_retries(times: 3)
  attempts = 0
  begin
    attempts += 1
    yield
  rescue StandardError => e
    retry if attempts < times
    raise e
  end
end
