defmodule MyAppTest do
  use ExUnit.Case

  alias MyApp.User

  describe "User.new/2" do
    test "creates a user with name and email" do
      user = User.new("Alice", "alice@example.com")
      assert user.name == "Alice"
      assert user.email == "alice@example.com"
    end

    test "default age is 0" do
      user = User.new("Bob", "bob@example.com")
      assert user.age == 0
    end
  end

  describe "MyApp.version/0" do
    test "returns a version string" do
      assert is_binary(MyApp.version())
    end
  end
end
