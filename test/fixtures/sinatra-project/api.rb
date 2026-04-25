require 'sinatra/base'
require 'json'

# Modular-style Sinatra app
class ApiApp < Sinatra::Base
  get '/items' do
    content_type :json
    [].to_json
  end

  post '/items' do
    content_type :json
    status 201
    { created: true }.to_json
  end

  get '/items/:id' do
    content_type :json
    { id: params[:id] }.to_json
  end

  delete '/items/:id' do
    status 204
  end

  # A helper method — not a route
  def find_item(id)
    nil
  end
end
