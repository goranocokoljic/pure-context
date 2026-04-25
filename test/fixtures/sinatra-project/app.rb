require 'sinatra'
require 'json'

# Classic-style Sinatra app

get '/users' do
  content_type :json
  { users: [] }.to_json
end

get '/users/:id' do
  content_type :json
  { id: params[:id] }.to_json
end

post '/users' do
  content_type :json
  status 201
  { created: true }.to_json
end

put '/users/:id' do
  content_type :json
  { updated: true }.to_json
end

delete '/users/:id' do
  status 204
end

patch '/users/:id' do
  content_type :json
  { patched: true }.to_json
end
