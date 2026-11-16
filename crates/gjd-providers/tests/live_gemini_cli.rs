mod support;

use gjd_providers::GeminiCli;

#[tokio::test]
#[ignore = "runs the real Gemini CLI CLI and spends tokens; needs its login"]
async fn r1_request_returns_variants_that_target_only_the_selected_file() {
    support::variants_target_only_the_selected_file(&GeminiCli).await;
}

#[tokio::test]
#[ignore = "runs the real Gemini CLI CLI and spends tokens; needs its login"]
async fn read_only_run_cannot_change_project_files_even_when_asked_to() {
    support::read_only_run_cannot_change_project_files(&GeminiCli).await;
}

#[tokio::test]
#[ignore = "runs the real Gemini CLI CLI and spends tokens; needs its login"]
async fn cancelling_terminates_the_provider_process_group_within_three_seconds() {
    support::cancelling_stops_the_process_group_within_three_seconds(&GeminiCli).await;
}
