# FSM Design

FSM은 `if`와 `case`를 모아 놓은 코딩 패턴이 아니라, protocol transaction의 **phase와 resource ownership을 cycle 단위로 저장하는 하드웨어**다. 좋은 FSM은 state 수가 적어서가 아니라, 각 state의 의미와 허용 event, side effect, exit condition이 명확해서 검증 가능한 구조다.

State encoding의 면적·타이밍 비교는 [FSM and Counter Encoding](../05_area/fsm_counter_encoding.md), state의 owner와 lifetime은 [State Partitioning and Ownership](../02_architecture/state_partitioning_and_ownership.md), 비정상 state 처리는 [Illegal State Recovery](illegal_state_recovery.md)가 담당한다. 이 문서는 functional state architecture와 request/response cycle contract에 집중한다.

## 1. Hardware View

일반적인 synchronous FSM은 세 부분으로 볼 수 있다.

```text
inputs/events ──> next-state decode ──> state register
      │                    │                   │
      └────────────────────┴──> output/side-effect decode
```

- **State register**: 현재 protocol phase 또는 ownership을 보존한다.
- **Next-state decode**: 현재 state와 accepted event로 다음 state를 결정한다.
- **Output/side-effect decode**: ready, valid, enable, write, clear와 같은 control을 만든다.

합성 결과는 state FF만이 아니다. State decode, event priority, output MUX, high-fanout enable, reset과 illegal-state logic도 함께 구현된다. 따라서 RTL 줄 수나 coding style의 개수만으로 FSM 품질이나 PPA를 판단할 수 없다.

## 2. State는 Protocol Phase와 Ownership을 나타낸다

State를 추가하기 전에 다음 질문에 답한다.

1. 이 cycle에 누가 resource 또는 payload를 소유하는가?
2. 어떤 input event가 legal한가?
3. 어떤 output이 stable해야 하는가?
4. 다음 phase로 이동시키는 **accepted event**는 무엇인가?
5. Reset, flush 또는 abort가 이 phase를 어떻게 종료하는가?

예를 들어 single-outstanding controller는 다음 세 phase로 충분할 수 있다.

| State | 의미 | 허용 event | 보존해야 할 정보 |
|---|---|---|---|
| `IDLE` | request를 받을 수 있음 | request acceptance | accepted payload |
| `EXEC` | resource가 request를 처리 중 | completion | operation context |
| `RESP` | response가 consumer 소유가 되기를 기다림 | response acceptance | response payload |

Debug 표시만을 위해 state를 추가하거나, 같은 ownership과 같은 허용 event를 가진 phase를 습관적으로 나누면 state FF보다 decode와 검증 공간이 더 커질 수 있다. 반대로 output stability나 distinct interruptibility가 필요하면 state를 분리하는 편이 명확하다.

## 3. Request, Acceptance, Completion은 서로 다르다

`req_valid`는 source가 request를 제시했다는 **level**이다. Controller가 transaction을 시작한 사건은 다음 accepted event다.

```systemverilog
assign req_accept = req_valid && req_ready;
```

마찬가지로 operation의 `complete`와 response channel의 `resp_accept`는 다르다.

- `complete`: executor가 결과 생산을 끝낸 cycle
- `resp_valid`: 결과가 consumer에게 유효한 동안 유지되는 state/level
- `resp_accept = resp_valid && resp_ready`: consumer가 결과 ownership을 받은 event

Completion에서 바로 `IDLE`로 돌아가면 downstream backpressure 중 response를 잃을 수 있다. Response payload와 `resp_valid`를 `RESP` phase에서 유지한 뒤 acceptance에서 ownership을 넘겨야 한다.

## 4. Moore와 Mealy 선택

| 구조 | Output 기준 | 장점 | 주의점 |
|---|---|---|---|
| Moore-like | registered state | output stability와 cycle reasoning이 단순 | state transition 뒤 output이 보이므로 latency가 늘 수 있음 |
| Mealy-like | state와 current input | 같은 cycle 반응, bubble 제거 가능 | input→control combinational path, glitch와 loop 가능성 |

`resp_valid = (state_q == ST_RESP)`는 Moore-like다. 반면 `req_ready`가 `resp_ready`에 직접 의존해 response acceptance와 새 request acceptance를 같은 edge에 merge하면 Mealy path가 생긴다. 이 최적화는 throughput을 높일 수 있지만 upstream/downstream ready 경로가 연결되므로 STA와 combinational-loop 검토가 필요하다.

Output이 외부 clock, asynchronous pin 또는 glitch-sensitive enable을 직접 제어한다면 단순히 simulation에서 맞는 것만으로 부족하다. Registered output이나 별도 protocol boundary가 필요할 수 있다.

## 5. Generic Valid/Ready Controller

다음 예제는 single-outstanding request를 처리하고 결과를 backpressure 가능한 response로 전달한다. Functional priority는 다음과 같다.

> asynchronous reset → synchronous flush/abort → state-specific accepted events → hold

`flush` cycle에는 ready/valid를 mask하므로 request, completion, response가 동시에 들어와도 어느 것도 accepted event가 되지 않는다. `RESP`에서 response가 받아들여지는 edge에는 새 request도 함께 받아 bubble 없이 `EXEC`로 이동할 수 있다.

```systemverilog
module valid_ready_controller #(
  parameter int unsigned REQ_W = 16,
  parameter int unsigned RSP_W = 16
) (
  input  logic             clk,
  input  logic             rst_n,
  input  logic             flush,

  input  logic             req_valid,
  output logic             req_ready,
  input  logic [REQ_W-1:0] req_data,

  input  logic             complete,
  input  logic [RSP_W-1:0] complete_data,

  output logic             exec_active,
  output logic [REQ_W-1:0] active_req_data,

  output logic             resp_valid,
  input  logic             resp_ready,
  output logic [RSP_W-1:0] resp_data,

  output logic             busy
);
  typedef enum logic [1:0] {
    ST_IDLE,
    ST_EXEC,
    ST_RESP
  } state_t;

  state_t state_q, state_d;
  logic [REQ_W-1:0] request_q;
  logic [RSP_W-1:0] response_q;
  logic req_accept, complete_accept, resp_accept;

  assign resp_data  = response_q;
  assign active_req_data = request_q;

  // Exact-match output decode keeps unused/X-containing encodings inactive.
  // RESP refill is legal only when the current response is accepted.
  always_comb begin
    req_ready   = 1'b0;
    resp_valid  = 1'b0;
    exec_active = 1'b0;
    busy        = 1'b0;

    case (state_q)
      ST_IDLE: begin
        req_ready = rst_n && !flush;
      end
      ST_EXEC: begin
        exec_active = rst_n && !flush;
        busy = rst_n && !flush;
      end
      ST_RESP: begin
        req_ready  = rst_n && !flush && resp_ready;
        resp_valid = rst_n && !flush;
        busy = rst_n && !flush;
      end
      default: ;
    endcase
  end

  assign req_accept      = req_valid && req_ready;
  assign resp_accept     = resp_valid && resp_ready;
  assign complete_accept = exec_active && complete;

  always_comb begin
    state_d = state_q;

    if (flush) begin
      state_d = ST_IDLE;
    end else begin
      unique case (state_q)
        ST_IDLE: begin
          if (req_accept)
            state_d = ST_EXEC;
        end

        ST_EXEC: begin
          if (complete_accept)
            state_d = ST_RESP;
        end

        ST_RESP: begin
          if (resp_accept) begin
            if (req_accept)
              state_d = ST_EXEC; // consume response and refill
            else
              state_d = ST_IDLE;
          end
        end

        default: state_d = ST_IDLE;
      endcase
    end
  end

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      state_q <= ST_IDLE;
    end else begin
      state_q <= state_d;

      if (req_accept)
        request_q <= req_data;

      if (complete_accept)
        response_q <= complete_data;
    end
  end
endmodule
```

`request_q`와 `response_q`는 각 valid phase 밖에서는 architecturally invalid이므로 예제에서는 reset하지 않는다. Test, safety, X-propagation 또는 information-flow requirement가 있으면 reset 정책이 달라질 수 있다. Reset assertion/release 구조 자체는 [Reset](../07_reset/overview.md)에서 다룬다.

### Example contract

- 예제의 지원 범위는 `REQ_W >= 1`, `RSP_W >= 1`이다. 이 값들은 port range에 직접 쓰이므로 configuration/elaboration 단계에서 사전 검증한다.
- Source는 `req_valid`를 acceptance까지 유지하고 `req_data`를 안정적으로 유지한다.
- `active_req_data`는 `exec_active=1`인 동안에만 유효하며 executor가 accepted operation context로 사용한다.
- Executor는 `ST_EXEC`에서 accepted request마다 정확히 한 cycle의 `complete`를 한 번 발생시킨다. 이 예제는 duplicate completion을 queue하지 않는다.
- Controller는 accepted request마다 정확히 하나의 completion을 기대한다.
- Response payload는 `resp_valid && !resp_ready` 동안 안정적이다.
- `flush`는 in-flight request와 pending response를 폐기한다. 폐기 사실을 software나 upstream에 알려야 한다면 별도 abort response/error contract가 필요하다.
- 이 예제의 모든 input은 `clk` domain에 이미 synchronous하다. CDC 신호라면 먼저 적절한 crossing protocol을 사용한다.

## 6. Simultaneous Event와 Back-to-Back Cycle Audit

RTL을 읽는 것만으로 priority를 추측하지 말고 edge 직전 값, accepted event, edge 이후 state를 표로 고정한다.

| Edge | Edge 직전 state/input | Accepted event | Edge 이후 state | 의미 |
|---|---|---|---|---|
| E0 | `rst_n=0` | 없음 | `IDLE` | reset 우선 |
| E1 | `IDLE`, request A valid | `req_accept(A)` | `EXEC` | A payload capture |
| E2 | `EXEC`, request B valid | 없음 | `EXEC` | B는 아직 accepted 아님 |
| E3 | `EXEC`, `complete(A)=1` | `complete_accept(A)` | `RESP` | A response capture |
| E4 | `RESP`, `resp_ready=1`, B valid 유지 | `resp_accept(A)` + `req_accept(B)` | `EXEC` | consume과 refill merge |
| E5 | `EXEC`, `flush=1`, `complete=1` | 없음 | `IDLE` | flush가 completion보다 우선 |

E2의 B request를 “이미 들어온 transaction”으로 세면 안 된다. Source가 valid를 유지했다면 E4에서야 accepted된다. E4는 두 사건 중 하나를 버리는 priority가 아니라, 서로 다른 ownership transfer를 한 edge에 **merge**한 것이다.

다음 조합도 명세와 test에 포함한다.

- Reset assertion과 모든 event의 동시 발생
- Flush와 request/completion/response-ready 동시 발생
- Completion 직전, 같은 cycle, 직후의 flush
- Response stall 중 payload stability
- `RESP` refill의 연속 반복
- Illegal completion, duplicate completion과 unsolicited response

동시 사건을 priority, merge, reject 또는 queue 중 무엇으로 다룰지는 [Priority and Simultaneous Events](priority_and_simultaneous_events.md)에서 체계화한다.

## 7. Synthesis, STA와 PPA 관점

### Synthesis

Tool은 state register와 next-state/output logic을 인식하고 encoding을 유지하거나 바꿀 수 있다. 결과는 RTL qualifier, synthesis option, library와 constraints에 따라 달라진다. `unique case`나 특정 coding template가 원하는 one-hot/binary 구현 또는 safe recovery를 자동으로 보장한다고 가정하지 않는다.

### Timing

대표 경로는 다음과 같다.

- state FF → state decode → `req_ready`/`resp_valid`
- downstream `resp_ready` → `req_ready` → upstream valid/ready control
- completion/data → response register
- event decode → state FF D

Bubble-free refill은 throughput에 유리하지만 `resp_ready`에서 `req_ready`로 combinational path를 만든다. Interface를 register slice로 나누면 timing은 쉬워질 수 있으나 latency 또는 bubble이 늘 수 있다.

### Power와 area

State 수를 줄이면 항상 area가 줄지는 않는다. State를 합치면서 넓은 compare, deeper decode 또는 toggle이 큰 Mealy cone이 생길 수 있다. 반대로 output을 register하거나 phase를 분리하면 FF/clock load는 늘지만 decode/fanout을 줄일 수 있다. Mapping과 physical implementation 결과로 비교한다.

## 8. 적용하면 안 되는 단순화

- Response backpressure가 있는데 completion에서 곧바로 `IDLE`로 돌아간다.
- Request가 제시되었다는 이유만으로 payload를 사용하고 `req_accept`를 확인하지 않는다.
- 서로 다른 resource owner나 interruptibility를 가진 phase를 state 수 절감을 위해 합친다.
- Latency가 바뀌는데 Moore output을 Mealy output으로 단순 치환한다.
- Clock domain을 넘는 event를 FSM input에 직접 연결한다.
- Encoding 변경을 functional state architecture 개선으로 포장한다.

## 9. Common Mistakes

### State 이름은 있지만 phase contract가 없다

`WAIT`, `DONE` 같은 이름만 있고 누가 무엇을 보존하며 어떤 event가 state를 끝내는지 정의하지 않는다.

### Completion과 response acceptance를 같은 사건으로 본다

Downstream stall에서 response가 유실되거나 덮어써진다.

### 모든 output을 combinational로 만들어 latency를 줄인다

Control path, glitch, output stability와 combinational loop를 함께 검토하지 않는다.

### Default recovery만 있으면 안전하다고 생각한다

Illegal encoding cycle에 side effect가 발생하지 않는지, error를 기록하는지, recovery가 protocol상 허용되는지 별도 검토해야 한다.

### Coding template를 architecture 품질로 오해한다

One-process/two-process/three-process style 중 무엇을 사용해도 같은 잘못된 phase와 priority를 구현할 수 있다. Team lint/readability 규칙은 중요하지만 functional contract를 대신하지 않는다.

## 10. Verification Strategy

### Assertions

다음 property는 예제 내부 신호를 관찰한다고 가정한다. `|=>`의 consequent는 다음 clock sample에서, 이전 edge의 nonblocking assignment 결과를 관찰한다.

```systemverilog
default clocking cb @(posedge clk); endclocking
default disable iff (!rst_n);

ap_request_enters_exec:
  assert property (req_accept |=> state_q == ST_EXEC);

ap_request_payload_captured:
  assert property (req_accept |=>
                   request_q == $past(req_data));

ap_completion_captures_response:
  assert property (complete_accept |=>
                   (state_q == ST_RESP &&
                    response_q == $past(complete_data)));

ap_stalled_response_stable:
  assert property (resp_valid && !resp_ready && !flush |=>
                   $stable(response_q));

ap_flush_returns_idle:
  assert property (flush |=> state_q == ST_IDLE);

ap_refill_has_no_idle_bubble:
  assert property ((state_q == ST_RESP) && resp_accept && req_accept |=>
                   state_q == ST_EXEC);
```

### Dynamic와 formal

- Directed test로 cycle audit의 각 행과 모든 simultaneous 조합을 재현한다.
- Random backpressure와 held-valid를 사용해 no-loss/no-duplicate를 확인한다.
- Accepted request 수, completion 수, accepted response 수를 scoreboard로 비교한다.
- Formal에서는 environment assumption과 DUT guarantee를 분리하고 outstanding depth를 invariant로 둔다.
- Illegal state, unexpected completion, reset/flush interruption을 fault/injection scenario로 넣는다.

## 11. Design Review Checklist

- [ ] 각 state가 protocol phase 또는 ownership으로 설명되는가?
- [ ] Request와 accepted request를 구분했는가?
- [ ] Completion과 response acceptance를 구분했는가?
- [ ] 모든 state의 legal input event와 side effect가 정의됐는가?
- [ ] Reset, flush/abort, accept와 complete의 priority가 명시됐는가?
- [ ] Back-to-back과 same-edge consume/refill을 cycle table로 확인했는가?
- [ ] Moore/Mealy 선택의 latency, combinational path와 stability 비용을 검토했는가?
- [ ] Payload가 valid 밖에서 reset되지 않아도 되는 근거가 있는가?
- [ ] Encoding과 illegal recovery를 functional architecture와 분리해 검토했는가?
- [ ] Assertions가 preponed sampling과 NBA 결과를 올바르게 반영하는가?

## 관련 문서

- [Priority and Simultaneous Events](priority_and_simultaneous_events.md)
- [Pulse, Level, and Event](pulse_level_event.md)
- [Illegal State Recovery](illegal_state_recovery.md)
- [FSM and Counter Encoding](../05_area/fsm_counter_encoding.md)
- [State Partitioning and Ownership](../02_architecture/state_partitioning_and_ownership.md)
- [Reset](../07_reset/overview.md)
