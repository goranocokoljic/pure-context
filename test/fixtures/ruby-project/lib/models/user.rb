require 'json'
require_relative './base_model'

# Represents an application user.
class User
  # The maximum number of login attempts before lockout.
  MAX_LOGIN_ATTEMPTS = 5

  attr_accessor :name, :email

  # Creates a new user with the given name and email.
  def initialize(name, email)
    @name = name
    @email = email
  end

  # Returns the user's display name.
  def display_name
    "#{@name} <#{@email}>"
  end

  # Finds a user by their ID.
  def self.find(id)
    nil
  end

  # Returns all users as a JSON string.
  def self.all_to_json
    [].to_json
  end

  private

  def validate_email
    @email.include?('@')
  end
end

# A helper module for serialization.
module Serializable
  VERSION = '1.0'

  def to_hash
    instance_variables.each_with_object({}) do |var, hash|
      hash[var.to_s.delete('@')] = instance_variable_get(var)
    end
  end

  def to_json_string
    to_hash.to_json
  end
end

# A standalone greeting function.
def greet(name)
  "Hello, #{name}!"
end
