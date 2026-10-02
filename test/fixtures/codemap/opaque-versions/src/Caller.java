import com.swfte.sdk.SwfteClient;
import org.springframework.web.client.RestTemplate;
class Caller { void run(SwfteClient client, RestTemplate http) {
client.workflows().invokeVersion("wf_opaque_java", "v3", java.util.Map.of("amount",1));
client.workflows().invokeVersionAndWait("wf_opaque_wait_java", "custom@v3:release", java.util.Map.of("amount",1),1000,10,false);
http.postForObject("https://api.swfte.com/v2/workflows/wf_opaque_raw_java/versions/custom%40v3%3Arelease/invoke", null, String.class);
} }
