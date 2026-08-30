# Pipeline Design

Pipeline은 긴 combinational work를 여러 register stage로 나누어 각 stage가 한 clock period 안에 완료되도록 만드는 microarchitecture다.

> Pipeline의 목적은 register를 많이 넣는 것이 아니라, latency·throughput·timing budget을 만족하도록 work와 control을 stage 사이에 배치하는 것이다.

용어는 [Canonical RTL Design Terminology](../01_fundamentals/terminology.md), path 분석은 [Critical Path](critical_path.md)를 참고한다.

## 1. Why It Matters

한 cycle에 compare, MUX, arithmetic와 formatting이 연속되면 target period를 넘을 수 있다.

```text
Before

Input FF ── compare ── select ── multiply ── add ── Output FF
          <--------------- one timing path --------------->
```

중간 register를 넣으면 combinational path를 실제로 분할할 수 있다.

```text
After

Input FF ── compare/select ── Stage FF ── multiply/add ── Output FF
          <--- stage 0 ---->             <--- stage 1 --->
```

하지만 latency, FF 수, clock power, reset/control alignment와 verification state space가 늘 수 있다. 따라서 “timing fail → pipeline 추가”가 자동 답은 아니다.

## 2. Latency와 Throughput을 분리한다

2-stage pipeline이 매 cycle 새 input을 받는 예:

```text
cycle       0      1      2      3      4
input       A      B      C
stage 0     A      B      C
stage 1            A      B      C
output                     A      B      C
```

- latency: interface 정의에 따라 2 cycle
- initiation interval: 1 cycle
- steady-state throughput: 1 result/cycle

Pipeline을 추가하기 전 다음을 명시한다.

- 첫 input accept edge
- output valid edge
- stall이 없을 때의 latency
- stall/flush 시 variable latency 여부
- initiation interval
- backpressure behavior

## 3. RTL Example: Data와 Valid를 함께 이동

다음은 두 개의 arithmetic 구간 사이에 pipeline register를 둔 generic example이다.

```systemverilog
module pipelined_mac #(
    parameter int W = 16
) (
    input  logic                 clk,
    input  logic                 rst_n,
    input  logic                 in_valid,
    input  logic [W-1:0]         a,
    input  logic [W-1:0]         b,
    input  logic [(2*W)-1:0]     c,
    output logic                 out_valid,
    output logic [(2*W):0]       result
);
    logic                 valid_s1;
    logic [(2*W)-1:0]     product_s1;
    logic [(2*W)-1:0]     c_s1;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            valid_s1  <= 1'b0;
            out_valid <= 1'b0;
        end else begin
            valid_s1  <= in_valid;
            out_valid <= valid_s1;

            if (in_valid) begin
                product_s1 <= a * b;
                c_s1       <= c;
            end

            if (valid_s1)
                // Extend both operands before addition so the carry bit is kept.
                result <= {1'b0, product_s1} + {1'b0, c_s1};
        end
    end
endmodule
```

핵심은 다음과 같다.

- `c`도 `product`와 같은 transaction에 맞춰 stage register에 저장한다.
- `valid`가 data와 동일한 stage 수로 이동한다.
- Data register는 invalid cycle에 update하지 않아 switching을 줄인다.
- Data register를 reset하지 않은 것은 valid 이전 값이 사용되지 않는다는 contract 때문이다.

실제 interface가 ready/valid라면 단순 valid shift만으로 충분하지 않을 수 있다. Stall 시 모든 관련 data/control stage가 동일하게 hold되어야 한다.

## 4. Pipeline Balancing

Stage를 두 개로 나눴다고 delay가 자동으로 절반이 되지 않는다.

```text
Bad balance

Stage 0: compare + decode + large MUX + multiply   85%
Stage 1: add + register                           15%

Better balance candidate

Stage 0: compare + decode + preselect             45%
Stage 1: multiply + add or mapped macro stage     55%
```

실제 balance는 cell delay뿐 아니라 다음에 의존한다.

- register clock-to-Q와 setup overhead
- net delay와 placement
- hard macro/DSP input-output register 위치
- late-arriving control
- fanout와 congestion
- stage별 uncertainty와 skew

한 stage를 너무 작게 만들면 register overhead가 이익보다 커질 수 있다.

## 5. Control Alignment

Data만 pipeline하고 select, mode, sign, tag 또는 exception flag를 그대로 두면 다른 transaction의 control이 적용될 수 있다.

```text
transaction A data ── stage 0 ── stage 1
transaction A mode ──────────────X  // alignment lost
```

각 transaction과 함께 이동해야 할 metadata를 inventory한다.

- valid
- ready/backpressure state
- opcode/mode/select
- sign/rounding/saturation mode
- destination tag/ID
- error/exception flag
- first/last packet marker

Review에서는 “data latency”가 아니라 **transaction latency**를 본다.

## 6. Stall, Backpressure, Flush

### Free-running pipeline

항상 한 stage씩 이동하며 invalid bubble은 valid bit로 표시한다. Control이 단순하지만 downstream이 멈출 수 없는 구조에 적합하다.

### Clock-enable pipeline

Global 또는 stage enable이 false면 data와 valid가 함께 hold된다.

```systemverilog
if (pipe_en) begin
    data_s1  <= data_s0;
    valid_s1 <= valid_s0;
end
```

Enable fanout와 timing cost를 확인한다.

### Elastic pipeline

각 stage가 valid/ready handshake와 storage를 가져 downstream stall을 흡수한다. Throughput 유연성은 좋아지지만 control, area와 formal verification 복잡도가 증가한다.

### Flush

Branch cancel, exception, reset 또는 mode change에서 in-flight transaction을 버릴 수 있다면 어느 stage의 valid를 언제 clear하는지 정의한다. Data 자체를 모두 clear할 필요는 없지만 stale valid가 남아서는 안 된다.

## 7. Feedback Dependency

Feed-forward datapath는 pipeline하기 비교적 쉽지만 feedback loop는 iteration interval을 제한한다.

```text
state[n] ── combinational update ──> state[n+1]
   ▲                                  │
   └──────────────────────────────────┘
```

중간 register를 추가하면 algorithm의 다음 iteration이 이전 결과를 더 늦게 보게 되어 기능이 바뀔 수 있다.

검토할 대안:

- look-ahead 또는 parallel prefix
- interleaving independent contexts
- algorithm reformulation
- multi-cycle iteration
- target frequency 완화

Feedback path에는 pipeline register를 “그냥 한 개” 넣을 수 없다.

## 8. Pipeline vs Parallel Pre-computation vs MCP

| 항목 | Pipeline | Parallel/pre-compute | MCP |
|---|---|---|---|
| Hardware path | register로 분할 | 여러 결과를 미리 계산 | 그대로 유지 |
| Latency | 증가 가능 | 유지 가능 | 기존 delayed capture 유지 |
| Throughput | 유지/개선 가능 | 유지 가능 | source-hold 구조는 낮을 수 있음 |
| Area | FF/control 증가 | logic 증가 | constraint 자체는 증가 없음 |
| Power | clock/data FF 증가 | switching 증가 가능 | long combinational activity 유지 |
| 주요 위험 | alignment/stall/flush | area와 glitch | 잘못된 exception |

결과가 반드시 next cycle에 필요하고 latency를 늘릴 수 없다면 parallel/pre-computation을 검토할 수 있다. Architecture가 이미 여러 cycle 뒤에만 capture한다면 [MCP](multi_cycle_path.md)가 맞을 수 있다.

## 9. Reset Strategy

모든 pipeline data FF를 reset할 필요는 없다. Valid/control이 reset되어 invalid data를 mask한다면 datapath 초기값은 don't-care일 수 있다.

```text
Reset candidates

valid/control state  ── usually known state required
payload data         ── may not need reset if invalid is enforced
```

불필요한 reset 제거는 reset routing과 cell 선택을 줄일 수 있지만 다음을 확인한다.

- X-propagation verification strategy
- scan/test requirement
- safety requirement
- output이 valid 없이 관찰될 가능성
- reset 중 clock gating과 stage enable

## 10. PPA Impact

### Timing

Combinational path가 분할되어 setup timing을 개선할 수 있다. 그러나 late control, unbalanced stage, register overhead와 physical distance가 남을 수 있다.

### Power

- FF clock pin activity 증가
- valid/control shift switching 증가
- shorter combinational cone으로 glitch 감소 가능
- invalid cycle data gating으로 switching 감소 가능

Pipeline이 power를 무조건 증가 또는 감소시킨다고 단정할 수 없다.

### Area

Payload width × stage 수만큼 FF가 증가할 수 있고 enable/reset MUX, buffer와 routing이 추가된다. 반대로 더 빠른 cell upsizing이 줄거나 macro register를 활용해 총 area가 완화될 수 있다.

## 11. Verification Strategy

### Latency property

Stall이 없는 fixed-latency pipeline이라면 accept와 output 사이의 cycle 관계를 확인한다.

```systemverilog
parameter int LATENCY = 2;

ap_valid_latency:
    assert property (@(posedge clk) disable iff (!rst_n)
        in_valid |-> ##LATENCY out_valid
    );
```

이 예는 설명용이다. Overlapping transaction, reset, stall과 backpressure가 있으면 tag/scoreboard 또는 protocol-specific property가 필요하다.

### Data association

- transaction tag가 같은 output과 연결되는가?
- Back-to-back input에서 data/control이 섞이지 않는가?
- Bubble이 payload를 유효하게 만들지 않는가?
- Stall 시 모든 stage가 같은 규칙으로 hold되는가?
- Flush된 transaction이 output에 나타나지 않는가?

### Equivalence

Latency가 달라졌으므로 cycle-by-cycle equivalence보다 latency mapping을 포함한 sequential equivalence 또는 transaction-level comparison을 사용한다.

## 12. Common Mistakes

- Timing report를 보기 전에 stage 수부터 결정한다.
- Data만 지연하고 valid/select/tag를 지연하지 않는다.
- 가장 느린 stage를 그대로 둔 채 register만 추가한다.
- Feedback dependency에 pipeline을 넣어 algorithm을 바꾼다.
- Reset으로 모든 payload FF를 clear해 routing과 power를 늘린다.
- Stall에서 일부 stage만 hold한다.
- Latency 증가는 고려하지만 initiation interval과 throughput은 확인하지 않는다.
- Pipeline 뒤의 new critical path와 hold violation을 확인하지 않는다.

## 13. Design Review Checklist

- [ ] Latency, throughput, initiation interval 요구가 각각 정의됐는가?
- [ ] 결과가 정말 next cycle에 필요한가?
- [ ] Stage별 logic와 net delay가 균형 잡혔는가?
- [ ] Data와 valid/select/tag/error가 같은 transaction으로 정렬되는가?
- [ ] Back-to-back transaction과 bubble이 안전한가?
- [ ] Stall, backpressure와 flush semantics가 정의됐는가?
- [ ] Feedback dependency가 기능을 바꾸지 않는가?
- [ ] Payload FF reset이 정말 필요한가?
- [ ] FF/clock power와 area 증가를 측정했는가?
- [ ] Pipeline 이후 setup뿐 아니라 hold와 physical congestion도 확인했는가?
- [ ] Latency-aware assertion/equivalence/scoreboard가 있는가?

## 관련 문서

- [Timing Design & Optimization](overview.md)
- [Critical Path](critical_path.md)
- [Multi-Cycle Path](multi_cycle_path.md)
- [Low-Power RTL Design](../04_low_power/overview.md)
