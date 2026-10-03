package com.acme.portal;

import com.swfte.sdk.SwfteClient;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class PortalApplication {

    public static void main(String[] args) {
        SpringApplication.run(PortalApplication.class, args);
    }

    /** Fails the boot early when the key is wrong: one cheap chat with the support agent. */
    @Bean
    CommandLineRunner warmup(SwfteClient client) {
        return args -> client.agents().chat("ag_JvSup1", "warmup");
    }
}
