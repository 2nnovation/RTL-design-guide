# Excessive Pipeline

Pipeline은 긴 combinational path를 register stage로 실제 분할하는 architecture다. Timing violation이 보일 때마다 stage를 하나씩 추가하거나, 정렬을 쉽게 하려고 모든 경로를 가장 긴 경로와 같은 깊이로 늘리면 timing 한 항목을 위해 latency·state·clock load와 protocol 복잡성을 과도하게 늘릴 수 있다.

[Pipeline Design](../03_timing/pipeline.md)은 stage 설계의 정본이며, latency와 initiation interval(II)은 [Latency, Throughput and Initiation Interval](../02_architecture/latency_throughput_ii.md), stall은 [Buffering and Backpressure](../02_architecture/buffering_and_backpressure.md), recurrence는 [Feedback Dependency](../02_architecture/feedback_dependency.md)를 따른다. 이 문서는 review에서 **추가 stage가 실제 bottleneck을 분할하는지와 비용을 정당화하는 증거**에 집중한다.

## 1. 문제: negative slack마다 register를 추가한다

다음과 같은 흐름이 anti-pattern이다.

```text
negative slack 발견
        ↓
원인과 transaction contract를 확인하지 않고 register 추가
        ↓
data에 맞춰 valid/tag/control에도 register 추가
        ↓
latency·reset·flush·stall state 증가
        ↓
다음 bottleneck 또는 ready/control path는 그대로
```

Pipeline은 constraint 변경이 아니라 hardware 변경이다. Stage FF, clock pin, data/control routing과 cycle-visible state가 실제 netlist에 추가된다. Interface가 output을 한 cycle 늦게 허용하는지 확인하지 않으면 timing을 고치면서 기능을 바꾼다.

### Bad example: 연산마다 stage를 만든다

```systemverilog
always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        valid_s1 <= 1'b0;
        valid_s2 <= 1'b0;
        valid_s3 <= 1'b0;
    end else begin
        sum_s1   <= a + b;
        valid_s1 <= in_valid;

        mask_s2  <= sum_s1 & mask;
        valid_s2 <= valid_s1;

        result   <= mask_s2;
        valid_s3 <= valid_s2;
    end
end
```

마지막 stage가 단순 wire-equivalent capture인데도 무조건 추가됐다면 latency와 FF만 늘 수 있다. 반대로 `mask`가 transaction과 함께 pipeline되지 않았으므로 `sum_s1`과 다른 cycle의 mask가 결합될 수 있다. Register 수가 많다는 사실은 올바른 pipeline이나 균형 잡힌 stage를 뜻하지 않는다.

## 2. 먼저 cycle contract를 비교한다

이 문서의 latency는 input accept edge에서 downstream이 해당 output valid/data를 synchronous하게 관찰·capture하는 edge까지의 cycle 수로 센다. Stall이 없는 예에서 원래 설계가 latency 2, II=1이었다고 하자.

| Edge | Input accept | Stage 1, NBA 후 | Output register, NBA 후 | Downstream capture |
|---|---|---|---|---|
| E0 | A | A | - | - |
| E1 | B | B | A | - |
| E2 | C | C | B | A |

불필요한 stage를 하나 더 넣으면 다음과 같다.

| Edge | Input accept | Stage 1, NBA 후 | Stage 2, NBA 후 | Output register, NBA 후 | Downstream capture |
|---|---|---|---|---|---|
| E0 | A | A | - | - | - |
| E1 | B | B | A | - | - |
| E2 | C | C | B | A | - |
| E3 | D | D | C | B | A |

II는 여전히 1이지만 latency는 2 cycle에서 3 cycle로 증가한다. Output register가 E1 NBA 뒤 A를 publish해도 같은 E1 edge의 downstream sequential logic과 concurrent assertion은 preponed value를 sampling하므로, A의 synchronous observation/capture edge는 E2다. 이 변경이 정당하려면 추가 register가 실제 worst combinational path를 분할하고, 새 latency를 모든 consumer·timeout·scoreboard가 수용해야 한다.

Bubble, stall과 output backpressure가 있으면 단순 표보다 acceptance edge와 commit edge를 tag로 추적해야 한다. Pipeline stage 수와 interface latency를 같은 말로 사용하지 않는다.

## 3. Stage를 추가해도 II가 개선되지 않는 경우

### Feedback/recurrence

```text
state[n] --> update logic --> state[n+1]
   ^                           |
   +---------------------------+
```

같은 context의 다음 iteration이 직전 결과에 의존하면 loop 안에 register를 추가할 때 recurrence latency도 늘어난다. Feed-forward path처럼 stage를 나눈다고 same-context II가 자동으로 1이 되지 않는다. Look-ahead, interleaving independent contexts 또는 algorithm reformulation이 필요할 수 있다.

### Shared resource

한 operator를 여러 client가 공유하고 arbitration이 한 번에 하나만 issue한다면 datapath를 pipeline해도 input arbiter나 resource occupancy가 II를 제한할 수 있다. Operator 내부가 II=1을 지원하는지, wrapper가 back-to-back issue를 허용하는지 분리한다.

### Downstream bottleneck

Downstream이 4 cycle마다 한 transaction만 받거나 long ready loop가 acceptance를 제한하면 upstream stage 추가가 end-to-end throughput을 개선하지 않는다. Queue가 burst를 잠시 흡수할 수는 있어도 steady-state service rate를 넘을 수 없다.

## 4. 숨은 failure mechanism

### Data/control reconvergence

Data만 지연하고 mode, sign, rounding, tag, first/last 또는 exception을 빠른 bypass로 보내면 다른 transaction이 결합된다.

```text
data A  ---- stage ---- stage ----+
mode A  -------- bypass ----------X--> result uses mode C
```

각 reconvergence point에서 모든 입력이 같은 acceptance event와 reset epoch를 나타내는지 확인한다.

### Unbalanced stage와 bypass

Register를 추가해도 한 stage에 compare→priority→wide MUX→arithmetic가 남아 있으면 worst path는 거의 줄지 않을 수 있다. Bypass가 여러 stage를 가로질러 final MUX로 들어오면 새 stage의 이득을 late select가 다시 소비한다.

### Variable latency

Fast path와 slow path의 stage 수가 다르면 response ordering, tag와 valid merge가 필요하다. “모든 경로를 같은 깊이로 맞추기”는 한 방법이지만, fast path에 불필요한 FF를 넣기 전에 reorder buffer, explicit path tag 또는 architecture partition의 비용을 비교한다.

### Ready combinational path

Elastic pipeline의 data path가 짧아져도 `ready`가 여러 stage를 역방향으로 combinational 통과하면 새로운 long path와 loop 위험이 생긴다. Registered ready나 skid capacity는 latency·storage contract와 함께 설계한다.

## 5. PPA와 검증 비용

### Timing과 physical

- Register clock-to-Q/setup와 clock uncertainty가 stage budget에서 새로 차감된다.
- 추가 FF가 placement row와 routing demand를 늘려 congestion을 만들 수 있다.
- Wide stage boundary가 macro 또는 natural locality를 잘라 long route를 만들 수 있다.
- Setup은 개선해도 짧은 stage에서 hold repair가 늘 수 있다.
- Control fanout와 clock/reset tree load가 새 critical/electrical 문제를 만들 수 있다.

### Power와 area

- Payload width × stage 수만큼 sequential bit와 clock pin load가 늘 수 있다.
- Valid/tag/enable/reset MUX와 elastic control이 추가된다.
- Shorter combinational cone으로 glitch가 줄 수 있지만 FF clock/internal power가 증가할 수 있다.
- Target macro의 internal register를 활용하면 외부 FF 비용과 결과가 달라질 수 있다.

### Verification state space

In-flight transaction 수, bubble 위치, stall 조합과 flush/reset 중간 상태가 증가한다. Cycle-by-cycle equivalence가 더 이상 맞지 않을 수 있어 latency mapping을 포함한 sequential equivalence나 transaction scoreboard가 필요하다.

## 6. Better decision order

Pipeline 전에 다음 순서를 적용한다.

1. **Remove**: 사용되지 않는 branch, observer와 duplicate state를 제거한다.
2. **Simplify**: width, compare, priority, decode와 arithmetic growth를 줄인다.
3. **Precompute**: late condition보다 앞서 독립 후보를 계산할 수 있는지 본다.
4. **Share or Duplicate**: resource sharing MUX를 줄이거나 physical locality를 위해 선택적으로 복제한다.
5. **Pipeline**: latency가 허용되고 실제 long path를 유효한 stage boundary로 나눌 때 추가한다.
6. **Physical feedback**: fanout, macro placement, congestion와 route가 지배하면 물리 원인을 고친다.

Architecture가 이미 여러 cycle 뒤 capture하도록 정의됐다면 MCP가 그 contract를 STA에 표현할 수 있지만, MCP와 pipeline을 negative slack에 대한 동등한 명령으로 취급하지 않는다. Pipeline은 회로를 바꾸고 MCP constraint는 회로를 바꾸지 않는다.

## 7. Better RTL pattern: transaction 전체를 이동한다

다음 fragment는 stall이 없는 two-register path에서 data와 metadata를 함께 이동한다. Accept E0에서 downstream observation/capture E2까지의 interface latency는 2 cycle이다. Priority는 `reset > normal shift`이고, reset은 valid만 지워 outstanding transaction을 취소한다.

```systemverilog
always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        valid_s1 <= 1'b0;
        out_valid <= 1'b0;
    end else begin
        valid_s1  <= in_valid;
        out_valid <= valid_s1;

        if (in_valid) begin
            data_s1 <= transform_a(in_data);
            mode_s1 <= in_mode;
            tag_s1  <= in_tag;
        end

        if (valid_s1) begin
            out_data <= transform_b(data_s1, mode_s1);
            out_tag  <= tag_s1;
        end
    end
end
```

`transform_a/b`는 generic combinational logic placeholder다. 실제 설계에서는 width와 mapping을 정의한다. Backpressure가 있으면 일부 stage만 advance시키지 말고 valid/ready storage invariant에 따라 data, mode와 tag를 함께 hold/move한다.

## 8. Pipeline이 정당한 경우와 retiming evidence

Pipeline이 정당한 대표 조건은 다음과 같다.

- Interface가 증가한 latency를 허용한다.
- Target throughput/II를 유지하거나 개선할 schedule이 있다.
- Natural register boundary가 long logic/net path를 실제로 분할한다.
- Data와 모든 control/metadata의 alignment가 정의된다.
- Stall, flush, reset과 error 처리의 stage policy가 있다.
- FF/clock/physical 비용보다 timing 또는 throughput 가치가 크다는 evidence가 있다.

Retiming이나 macro register inference에 기대는 경우 source code의 register 위치와 mapped register 위치가 다를 수 있다. 다음을 별도로 증명한다.

- Tool option과 target cell/macro가 실제 retiming을 허용했는가?
- Reset, enable, hierarchy, multicycle/false-path와 black box가 이동을 제한하지 않았는가?
- Mapped/post-place netlist의 stage 수와 path endpoints가 가설과 일치하는가?
- External latency, initial state와 equivalence가 보존됐는가?

“Tool이 알아서 pipeline한다”는 설명만으로 architecture signoff를 대신하지 않는다.

## 9. Verification과 evidence

### Assertion와 scoreboard

```systemverilog
ap_fixed_latency:
    assert property (@(posedge clk) disable iff (!rst_n)
        in_valid |-> ##2 out_valid);

ap_tag_alignment:
    assert property (@(posedge clk) disable iff (!rst_n)
        out_valid |-> (out_tag == $past(in_tag, 2)));
```

이 property는 stall·flush가 없는 fixed-latency 예에만 맞는다. Overlapping transaction의 data correctness는 acceptance 순서로 tag를 queue에 넣고 commit에서 비교하는 scoreboard가 더 명확하다. Reset/flush epoch, bubble과 backpressure가 있으면 expected queue에서 폐기/hold 규칙을 같은 cycle contract로 구현한다.

### Evidence set

- Cycle table: accept, stage occupancy, stall, flush와 commit
- Lint/elaboration: width, unaligned valid/tag와 unintended latch
- Synthesis: stage FF 수, enable/reset, macro register와 path 분할
- STA: stage별 setup/hold, ready/control/bypass와 all mode/corner
- Post-route: register/logic 위치, net delay, congestion와 hold repair
- PPA: 동일 workload에서 throughput, latency, clock/data power와 area
- Regression: interface latency, timeout, ordering와 reset/mode behavior

## 10. Design Review Checklist

- [ ] 추가 stage가 실제 worst cell/net path를 분할하는가?
- [ ] Latency와 II를 별도로 정의하고 전후 값을 비교했는가?
- [ ] Feedback, shared resource 또는 downstream rate가 II를 제한하지 않는가?
- [ ] Data·valid·mode·tag·exception이 같은 transaction으로 정렬되는가?
- [ ] Bypass/reconvergence와 variable-latency ordering을 검토했는가?
- [ ] Stall 시 모든 관련 state가 함께 hold/move하는가?
- [ ] Flush/reset이 모든 in-flight valid와 ownership을 처리하는가?
- [ ] Ready combinational path와 loop를 확인했는가?
- [ ] Remove/Simplify/Precompute/Share-or-Duplicate를 먼저 검토했는가?
- [ ] FF·clock power·reset/enable·routing·hold 비용을 포함했는가?
- [ ] Retiming/macro inference 결과를 mapped netlist로 확인했는가?
- [ ] Latency-aware scoreboard/equivalence와 post-route evidence가 있는가?

## 관련 문서

- [Pipeline Design](../03_timing/pipeline.md): stage balancing, alignment와 reset의 정본
- [Latency, Throughput and Initiation Interval](../02_architecture/latency_throughput_ii.md): cycle metric과 schedule
- [Buffering and Backpressure](../02_architecture/buffering_and_backpressure.md): elastic stage와 ready path
- [Feedback Dependency](../02_architecture/feedback_dependency.md): recurrence와 same-context II
- [Multi-Cycle Path](../03_timing/multi_cycle_path.md): 실제 delayed-capture contract
- [RTL to Post-Route Feedback](../12_physical_aware/rtl_to_post_route_feedback.md): stage별 physical evidence

## 참고 자료

- [AMD, Avoid Unnecessary Pipelining](https://docs.amd.com/r/en-US/ug949-vivado-design-methodology/Avoid-Unnecessary-Pipelining): 불필요한 pipeline과 register boundary 비용을 다루는 target-specific 공식 방법론
- [AMD, Vivado Design Suite User Guide: Synthesis (UG901)](https://docs.amd.com/r/en-US/ug901-vivado-synthesis): register, retiming과 target synthesis mapping에 관한 공식 가이드
- [OpenROAD, Gate Resizer](https://openroad.readthedocs.io/en/latest/main/src/rsz/README.html): placement 기반 timing repair와 routed parasitic 한계에 관한 공식 문서
