class PostsController
  before_action :authenticate, only: [:show]
  before_action :load_post

  def show; end
  def index; end
  def load_post; end

  private

  def authenticate
    # private method - should match with matchesPrivate
  end
end
