class Router
  def configure
    routing do
      get "/users"
      get "/posts"
      post "/users"
    end

    # This get is outside routing scope - should NOT match
    get "/standalone"
  end
end
