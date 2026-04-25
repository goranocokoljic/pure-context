Rails.application.routes.draw do
  get '/health', to: 'health#index'
  post '/login', to: 'sessions#create'

  resources :users
  resource :profile

  namespace :api do
    namespace :v1 do
      resources :posts
      get '/status', to: 'status#index'
    end
  end
end
