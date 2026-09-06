# Raw Clock Gating

`clock`는 일반 data signal이 아니다. Clock edge는 여러 register의 state transition 기준이며, duty cycle·skew·jitter와 test 동작까지 구현 flow가 함께 관리한다. 따라서 조합 논리로 clock을 직접 만들면 Boolean function은 맞아 보여도 새로운 edge와 짧은 pulse가 생길 수 있다.

이 문서는 clock gating의 전체 설계법을 반복하지 않는다. [Clock Gating](../06_clock/clock_gating.md)을 정본으로 두고, review에서 **raw gated clock을 발견하는 방법, 실패 조건, 대안과 증거**를 빠르게 판단하는 데 초점을 둔다.

## 1. 문제: data enable로 clock을 만들기

다음 코드는 `en=1`일 때만 register가 움직인다는 의도를 짧게 표현한다.

```systemverilog
logic gclk;

assign gclk = clk & en;

always_ff @(posedge gclk or negedge rst_n) begin
    if (!rst_n)
        state_q <= '0;
    else
        state_q <= state_d;
end
```

그러나 `en`은 이제 단순한 update 조건이 아니라 **clock edge를 생성하거나 제거하는 신호**다. `en`의 조합 glitch, source register의 clock-to-Q, 배선 지연과 active clock phase 중 전이가 모두 `gclk` waveform에 직접 반영된다.

다음과 같은 패턴은 같은 위험군에 속한다.

```systemverilog
assign gclk = clk & mode_en;
assign gclk = test_mode ? test_clk : func_clk;
assign gclk = clk | force_on;
assign gclk = clk & (req | pending_q);
```

Clock의 AND, OR, MUX 자체가 언제나 불법이라는 뜻은 아니다. 문제는 일반 조합 cell과 일반 RTL semantics만으로 **glitch-free clock 전환 조건과 implementation contract가 보장된다고 가정하는 것**이다.

## 2. 실패 메커니즘: active phase에서 enable이 바뀔 때

Positive-edge register를 구동하는 active-high clock을 생각하자. `clk`가 이미 high인 동안 `en`이 0에서 1로 바뀌면 AND 출력은 그 순간 0에서 1로 바뀐다. 원래 clock edge와 무관한 늦은 rising edge가 생긴다.

```text
time  ------------------------------------------------------------>

clk   ____/----------------\________/----------------\________
en    ____________/---------------------------\_______________
                 ^ clk가 이미 high일 때 en 상승  ^ en 하강
gclk  ____________/----\___________/------------\_______________
                 ^ extra/late edge  ^ 정상 edge   ^ high pulse 단축
```

- `en` 상승은 주기 중간에 extra/late edge를 만들 수 있다.
- `en` 하강은 high pulse를 잘라 minimum pulse width를 위반할 수 있다.
- 조합 decode에서 순간 glitch가 발생하면 의도하지 않은 매우 짧은 pulse가 생길 수 있다.
- 서로 다른 branch에 도달하는 지연이 다르면 일부 register만 edge를 보고 다른 register는 보지 않을 수 있다.

Simulation의 zero-delay waveform이나 느린 testbench stimulus에서 문제가 보이지 않아도 실제 mapped cell과 routing delay에서는 실패할 수 있다. 반대로 gate-level simulation에서 특정 pulse가 보였다는 사실만으로 signoff가 끝나는 것도 아니다. Minimum pulse width, gating setup/hold, skew와 generated-clock 관계는 STA·clock flow에서 분석해야 한다.

## 3. Hardware와 flow 관점

### 3.1 안전한 gating cell이 하는 일

ASIC의 일반적인 integrated clock-gating(ICG) 구조는 enable을 clock의 비활성 구간에 포착하고 active 구간 동안 고정한다. 개념적으로는 다음과 같다.

```text
                 +--------------------------+
en/test_en ----->| inactive-phase capture   |---- safe_en ----+
                 +--------------------------+                 AND ---> gclk
clk ----------------------------------------------------------+
```

실제 구현은 library의 characterized ICG cell, 해당 cell을 인식하는 synthesis/STA/CTS/DFT flow와 함께 사용해야 한다. 임의로 latch와 AND gate를 조합한 RTL을 모든 target의 보편적인 교체품으로 간주해서는 안 된다.

### 3.2 FPGA에서는 전용 자원을 사용한다

FPGA fabric의 LUT로 clock을 gating하면 전용 clock network를 벗어나거나 timing/power 품질이 나빠질 수 있다. Target이 제공하는 register clock-enable 또는 clock-buffer enable 자원과 권장 flow가 우선이다. 어떤 resource를 쓸지는 device family, clock topology와 tool version에 따라 달라진다.

AMD와 Altera의 공식 방법론도 fabric 조합 논리 대신 전용 clock-control resource와 flow를 사용하도록 안내한다. 이는 특정 FPGA target에 관한 지침이며, ASIC ICG signoff 절차를 대신하지 않는다.

## 4. 합성·STA·PPA에 미치는 영향

### Synthesis와 mapping

- `if (update_en)`은 functional enable을 표현한다. Tool과 target에 따라 register CE, feedback MUX 또는 clock-gating inference 후보가 될 수 있다.
- `posedge gclk`은 새로운 clock domain 또는 generated clock처럼 취급될 수 있다. Tool이 raw logic을 자동으로 안전한 ICG로 바꿀 것이라는 보장은 없다.
- Gating inference는 coding style뿐 아니라 minimum group size, library, hierarchy, scan option과 synthesis setting에 의존한다. Report에서 실제 mapping을 확인해야 한다.

### STA와 CTS

새 clock branch에는 최소한 다음 책임이 생긴다.

- Root clock과 gated/generated clock 관계 정의
- ICG enable의 clock-gating setup/hold check
- Minimum high/low pulse width와 duty-cycle 검토
- Gated branch의 insertion delay, skew와 CTS 범위
- Functional, test, scan, sleep/wake mode별 clock propagation
- Clock-off 상태의 CDC/RDC와 reset release 조건

Generated clock 선언만 추가하면 raw gate가 안전해지는 것은 아니다. Constraint는 존재하는 architecture를 분석할 뿐 위험한 waveform을 수정하지 않는다.

### Power와 area

Clock gating은 큰 clock load가 충분히 오래 idle일 때 clock pin과 downstream clock tree switching을 줄일 수 있다. 그러나 작은 group이나 자주 바뀌는 enable에는 ICG, enable generation, test override, routing과 CTS 비용이 절감보다 클 수 있다. 정확한 손익은 representative activity를 사용한 mapped/post-route evidence로 판단한다.

## 5. 권장 대안

### 5.1 먼저 data update만 멈추기

Architecture가 요구하는 것이 register hold라면 clock은 그대로 두고 update condition을 표현한다.

```systemverilog
always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n)
        state_q <= '0;
    else if (update_en)
        state_q <= state_d;
end
```

이 코드는 priority를 `reset > update > hold`로 명시한다. Clock pin은 계속 toggle할 수 있지만 functional edge와 STA clock 구조는 단순하다. Tool이 CE나 feedback MUX로 mapping할지, established flow가 ICG를 infer할지는 target 조건과 report로 확인한다. 자세한 구분은 [Register Enable](../04_low_power/register_enable.md)과 [Inferred vs Explicit Clock Gating](../06_clock/inferred_vs_explicit.md)을 참고한다.

### 5.2 Clock tree를 실제로 멈춰야 할 때

Clock power가 측정된 bottleneck이고 group size와 idle duty cycle이 gating을 정당화한다면 다음 순서로 다룬다.

1. Gating boundary와 gated state 목록을 정한다.
2. Enable을 생성하는 owner가 root/always-on clock에서 동작하는지 확인한다.
3. ASIC은 승인된 ICG abstraction과 insertion flow를, FPGA는 target 전용 clock-control primitive 또는 공식 inference flow를 사용한다.
4. Test enable, scan shift, reset assertion/release, wake-up request의 priority를 정의한다.
5. Synthesis, STA, CDC/RDC, DFT와 post-route clock/power report로 실제 구현을 확인한다.

ICG wrapper의 generic interface는 다음처럼 architecture boundary만 나타낼 수 있다. 내부 구현을 임의의 `assign clk_o = clk_i & en_i`로 채우지 않는다.

```systemverilog
module clock_control (
    input  logic clk_i,
    input  logic func_en_i,
    input  logic test_en_i,
    output logic clk_o
);
    // Target별 승인된 ICG/clock-buffer abstraction이 이 경계를 구현한다.
endmodule
```

Wrapper가 있다고 안전성이 자동 보장되는 것은 아니다. Target binding, constraints, test mode와 implementation checks가 같은 contract를 가리켜야 한다.

## 6. Reset, wake-up과 test의 숨은 실패

Function clock을 켜는 `pending_q`를 같은 function clock 아래에서 갱신하면 clock이 꺼진 뒤 다시 켤 방법이 없는 self-deadlock이 생긴다. Wake-up detector와 gate controller는 보통 [Root Clock vs Function Clock](../06_clock/root_vs_function_clock.md)에서 설명하는 always-on 책임에 속한다.

Reset도 polarity만 맞추면 끝나지 않는다.

- Synchronous reset은 clock이 멈춘 동안 적용되지 않는다.
- Asynchronous assertion 후 deassertion은 local clock edge와 recovery/removal 조건을 만족해야 한다.
- Reset 직후 gate가 닫혀 있으면 local initialization completion이 영원히 오지 않을 수 있다.
- Scan shift나 ATPG가 gated branch를 구동하려면 test override와 그 priority가 필요하다.

관련 reset sequence는 [Reset with Clock Gating](../07_reset/reset_with_clock_gating.md), release 위험은 [Reset Deassertion and RDC](../07_reset/reset_deassertion.md)를 정본으로 삼는다.

## 7. 예외와 증명 책임

다음 경우에는 조합 형태가 source에서 보이더라도 즉시 버그라고 단정할 수 없다.

- Target library primitive를 감싼 검증된 wrapper의 behavioral model
- Clock이 시작되기 전에만 configuration이 바뀌고 운용 중에는 고정된 test/reference clock 선택
- Device vendor가 문서화한 dedicated glitchless mux/buffer inference template
- 상위 analog/clock macro의 digital boundary model

그러나 예외를 주장하려면 다음 증거가 필요하다.

- Enable/select가 바뀔 수 있는 정확한 mode와 clock phase
- Target cell/primitive mapping과 implementation report
- Generated clock 및 gating check coverage
- Minimum pulse-width, skew와 mode별 STA 결과
- DFT/scan 및 reset/wake-up sequence 결과
- Wrapper 밖에서 raw combinational clock logic이 다시 생기지 않는 구조적 check

“Simulation에서 문제없었다” 또는 “enable은 보통 안정적이다”는 충분한 증거가 아니다.

## 8. Verification과 evidence

### RTL·structural check

- `always_ff @(posedge <derived_signal>)`와 clock net의 AND/OR/MUX를 lint/structural rule로 찾는다.
- Functional enable이 active clock phase 근처에서 변하는 negative test를 둔다.
- Clock off 중 reset, interrupt, wake-up과 back-to-back sleep/wake를 검증한다.
- Gate controller가 gated clock 자신의 state에 의존하는 cycle을 찾는다.

### Implementation evidence

- Synthesis clock-gating report: inferred/explicit ICG 수, group과 unmapped 후보
- Clock report: root/generated clock, propagation과 unconstrained endpoint
- STA: gating setup/hold, pulse-width, recovery/removal와 모든 functional/test mode
- CTS/post-route: skew, insertion delay, clock load와 congestion
- Power: 동일 activity·corner·scope에서 gating 전후 clock tree 및 sequential power
- DFT/CDC/RDC: test enable controllability와 clock-off crossing/reset behavior

Tool 이름이나 report field는 flow마다 다르므로 project signoff checklist에 실제 명령과 owner를 연결한다. Verification evidence를 해석하는 방법은 [Lint, Formal, and Equivalence](../13_verification/lint_formal_equivalence.md)와 [Reset and Mode Transition Verification](../13_verification/reset_mode_transition_verification.md)을 참고한다.

## 9. Design Review Checklist

- [ ] Clock net이 일반 combinational logic의 출력인가?
- [ ] 실제 요구가 clock stop인지 단순한 state hold인지 구분했는가?
- [ ] Enable/select가 active phase 중 바뀔 수 없다는 보장이 executable하게 검증되는가?
- [ ] ASIC ICG 또는 FPGA 전용 clock-control resource로 실제 mapping되는가?
- [ ] Root/generated clock와 gating setup/hold가 모든 mode에서 분석되는가?
- [ ] Minimum pulse width, duty cycle, skew와 CTS 범위를 확인했는가?
- [ ] Gate controller와 wake-up state가 always-on 영역에 있는가?
- [ ] Clock off 중 reset assertion/release와 first active edge가 정의됐는가?
- [ ] Test/scan enable의 priority와 controllability가 검증됐는가?
- [ ] ICG·routing·control overhead를 포함한 실제 PPA 이득이 있는가?

## 관련 문서

- [Clock Gating](../06_clock/clock_gating.md): ICG, inferred/explicit gating과 전체 clock architecture
- [Inferred vs Explicit Clock Gating](../06_clock/inferred_vs_explicit.md): insertion 책임과 target flow
- [Root Clock vs Function Clock](../06_clock/root_vs_function_clock.md): always-on controller와 self-deadlock
- [Register Enable](../04_low_power/register_enable.md): data enable과 feedback MUX
- [Reset with Clock Gating](../07_reset/reset_with_clock_gating.md): reset·force-on·wake-up sequence
- [RTL to Hardware Mapping](../11_synthesis/rtl_to_hardware_mapping.md): RTL pattern과 실제 mapping 증거

## 참고 자료

- [AMD, Use Clock Enable Pins of Dedicated Clock Buffers](https://docs.amd.com/r/en-US/ug949-vivado-design-methodology/Use-Clock-Enable-Pins-of-Dedicated-Clock-Buffers): FPGA 전용 clock buffer enable 사용 지침
- [Altera, Use Gated Clocks](https://docs.altera.com/r/docs/683082/25.1/quartus-prime-pro-edition-user-guide/use-gated-clocks?contentId=x3hh07ZotyuPlLtZYm_cmw): 전용 clock-control hardware, raw AND/OR gate 위험과 synchronous clock enable의 target-specific trade-off
- [OpenROAD, OpenSTA documentation](https://openroad.readthedocs.io/en/latest/main/src/sta/README.html): generated clock와 gated-clock check를 포함한 STA 기능
