defmodule MyApp.Macros do
  @moduledoc "Provides compile-time macros for the application."

  @doc "Defines a getter function for the given field."
  defmacro defgetter(field) do
    quote do
      def unquote(field)(struct), do: Map.get(struct, unquote(field))
    end
  end

  defmacrop private_helper(expr) do
    quote do: unquote(expr)
  end

  defprotocol Serializable do
    @doc "Serialize a value to string."
    def serialize(value)
  end

  defimpl Serializable, for: Integer do
    def serialize(int), do: Integer.to_string(int)
  end

  defimpl Serializable, for: BitString do
    def serialize(str), do: str
  end
end
