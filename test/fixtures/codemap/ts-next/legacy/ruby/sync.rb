# Legacy CRM sync (Ruby), still run nightly by the ops box.
require "net/http"
require "json"

uri = URI("https://api.swfte.com/agents/v2/workflows/wf_Lead5Q/invoke")
req = Net::HTTP::Post.new(uri, "Content-Type" => "application/json", "X-API-Key" => ENV["SWFTE_API_KEY"])
req.body = { email: "ops@acme.test" }.to_json
Net::HTTP.start(uri.host, uri.port, use_ssl: true) { |http| http.request(req) }
