defmodule MyApp.User do
  @moduledoc "Represents a user in the system."

  @type t :: %__MODULE__{
    name: String.t(),
    email: String.t(),
    age: non_neg_integer()
  }

  defstruct [:name, :email, age: 0]

  @spec new(String.t(), String.t()) :: t()
  @doc "Creates a new user struct."
  def new(name, email) do
    %__MODULE__{name: name, email: email}
  end

  @spec display_name(t()) :: String.t()
  @doc "Returns the display name."
  def display_name(%__MODULE__{name: name}), do: name

  def valid?(user) when is_binary(user.email) do
    String.contains?(user.email, "@")
  end

  defp sanitize(value) when is_binary(value) do
    String.trim(value)
  end
end
