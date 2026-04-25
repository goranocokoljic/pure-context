module Api
  module V1
    class PostsController < ActionController::API
      def index
        render json: Post.all
      end

      def show
        render json: Post.find(params[:id])
      end

      private

      def post_params
        params.require(:post).permit(:title, :body)
      end
    end
  end
end
