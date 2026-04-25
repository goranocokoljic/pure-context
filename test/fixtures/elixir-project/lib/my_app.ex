defmodule MyApp do
  @moduledoc """
  Main application module.
  Provides core functionality for the MyApp system.
  """

  alias MyApp.User
  import MyApp.Helpers
  use GenServer
  require Logger

  @type state :: map()

  @spec start_link(keyword()) :: {:ok, pid()} | {:error, term()}
  @doc "Starts the application server."
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "Returns the application version."
  def version, do: "1.0.0"

  defp init_state(opts) do
    Map.new(opts)
  end

  defmacro with_logging(do: block) do
    quote do
      Logger.info("Starting block")
      result = unquote(block)
      Logger.info("Block complete")
      result
    end
  end
end
