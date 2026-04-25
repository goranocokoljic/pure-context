defmodule MyApp.Repo do
  @moduledoc "Database repository behaviour."

  @callback insert(map()) :: {:ok, term()} | {:error, term()}
  @callback get(term(), term()) :: {:ok, term()} | {:error, :not_found}
  @callback delete(term()) :: :ok | {:error, term()}

  @type result(t) :: {:ok, t} | {:error, term()}

  @doc "Helper to unwrap an ok result."
  def unwrap!({:ok, value}), do: value
  def unwrap!({:error, reason}), do: raise(RuntimeError, message: inspect(reason))
end
