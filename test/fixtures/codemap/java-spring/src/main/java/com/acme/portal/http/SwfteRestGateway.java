package com.acme.portal.http;

import com.acme.portal.config.SwfteIds;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

/** Raw RestTemplate calls from before the SDK was adopted. */
@Component
public class SwfteRestGateway {

    private static final String SWFTE = "https://api.swfte.com/agents";

    private final RestTemplate rest;
    private final SwfteIds ids;

    @Value("${swfte.api-key}")
    private String apiKey;

    public SwfteRestGateway(RestTemplate rest, SwfteIds ids) {
        this.rest = rest;
        this.ids = ids;
    }

    private HttpHeaders headers() {
        HttpHeaders h = new HttpHeaders();
        h.setBearerAuth(apiKey);
        h.setContentType(MediaType.APPLICATION_JSON);
        return h;
    }

    @SuppressWarnings("rawtypes")
    public Map submitOrder(String orderId) {
        return rest.postForObject("https://api.swfte.com/agents/v2/workflows/wf_JvOrd1/invoke", new HttpEntity<>(Map.of("orderId", orderId), headers()), Map.class);
    }

    public ResponseEntity<Map<String, Object>> assessRisk(String customerId) {
        HttpEntity<Map<String, Object>> entity = new HttpEntity<>(Map.of("customerId", customerId), headers());
        return rest.exchange(SWFTE + "/v2/workflows/wf_JvRisk4/invoke", HttpMethod.POST, entity, new ParameterizedTypeReference<Map<String, Object>>() {});
    }

    @SuppressWarnings("rawtypes")
    public ResponseEntity<Map> reviewOnV4(String documentUrl) {
        return rest.postForEntity(SWFTE + "/v2/workflows/wf_JvCtr3/versions/4/invoke", new HttpEntity<>(Map.of("documentUrl", documentUrl, "jurisdiction", "US-DE"), headers()), Map.class);
    }

    @SuppressWarnings("rawtypes")
    public Map onboard(String accountId) {
        return rest.postForObject(SWFTE + "/v2/workflows/{id}/invoke", new HttpEntity<>(Map.of("accountId", accountId), headers()), Map.class, "wf_JvOnb2");
    }

    @SuppressWarnings("rawtypes")
    public Map reportRuns() {
        return rest.exchange(SWFTE + "/v2/workflows/wf_JvRpt6/executions", HttpMethod.GET, new HttpEntity<>(headers()), Map.class).getBody();
    }

    @SuppressWarnings("rawtypes")
    public Map askFaqWidget(String query) {
        return rest.postForObject(SWFTE + "/v1/widgets/wg_JvFaq3/public/invoke", Map.of("query", query), Map.class);
    }

    @SuppressWarnings("rawtypes")
    public Map openIntake() {
        return rest.postForObject(SWFTE + "/v2/chatflows/cf_JvInt5/sessions", new HttpEntity<>(Map.of("channel", "API"), headers()), Map.class);
    }

    @SuppressWarnings("rawtypes")
    public Map charge(String invoiceId) {
        return rest.postForObject(System.getenv("SWFTE_BASE_URL") + "/v2/workflows/wf_JvBil8/invoke", new HttpEntity<>(Map.of("invoiceId", invoiceId), headers()), Map.class);
    }

    @SuppressWarnings("rawtypes")
    public Map chargeTenant(String invoiceId) {
        return rest.postForObject(SWFTE + "/v2/workflows/{id}/invoke", new HttpEntity<>(Map.of("invoiceId", invoiceId), headers()), Map.class, ids.getBillingWorkflow());
    }
}
