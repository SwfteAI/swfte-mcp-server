// notify asks for an SEO audit of a freshly published page from the Go notifier sidecar.
package main

import (
	"bytes"
	"net/http"
	"os"
)

func main() {
	body := bytes.NewBufferString(`{"url":"https://acme.test/blog"}`)
	req, _ := http.NewRequest("POST", "https://api.swfte.com/agents/v2/workflows/wf_Seo3Pz/invoke", body)
	req.Header.Set("X-API-Key", os.Getenv("SWFTE_API_KEY"))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		os.Exit(1)
	}
	defer resp.Body.Close()
}
